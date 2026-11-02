// Ink Brain native helper: screen capture, speech in/out and app context over JSON lines on stdio.
import AppKit
import AVFoundation
import CoreMedia
import Foundation
import ImageIO
import ScreenCaptureKit
import Speech
import UniformTypeIdentifiers

// MARK: - Protocol

enum Out {
    private static let lock = NSLock()

    static func send(_ object: [String: Any]) {
        guard JSONSerialization.isValidJSONObject(object),
              var data = try? JSONSerialization.data(withJSONObject: object) else { return }
        data.append(0x0A)
        lock.lock()
        defer { lock.unlock() }
        FileHandle.standardOutput.write(data)
    }

    static func event(_ name: String, _ fields: [String: Any] = [:]) {
        var object = fields
        object["event"] = name
        send(object)
    }

    static func reply(_ id: Any, _ result: Any = NSNull()) {
        send(["id": id, "ok": true, "result": result])
    }

    static func fail(_ id: Any, _ message: String) {
        send(["id": id, "ok": false, "error": message])
    }
}

struct HelperError: LocalizedError {
    let message: String
    init(_ message: String) { self.message = message }
    var errorDescription: String? { message }
}

// MARK: - TCC responsibility

var spawnedChild: pid_t = 0

// Relaunch as our own responsible process so permission prompts name this helper, not the launching terminal or app.
func disclaimResponsibilityIfNeeded() {
    let environment = ProcessInfo.processInfo.environment
    if environment["INK_BRAIN_HELPER_CHILD"] != nil || environment["INK_BRAIN_INHERIT_TCC"] == "1" { return }
    guard let symbol = dlsym(UnsafeMutableRawPointer(bitPattern: -2), "responsibility_spawnattrs_setdisclaim"),
          let executable = Bundle.main.executablePath else { return }
    typealias Disclaim = @convention(c) (UnsafeMutablePointer<posix_spawnattr_t?>, Int32) -> Int32
    let disclaim = unsafeBitCast(symbol, to: Disclaim.self)
    var attributes: posix_spawnattr_t?
    posix_spawnattr_init(&attributes)
    defer { posix_spawnattr_destroy(&attributes) }
    guard disclaim(&attributes, 1) == 0 else { return }

    var childEnvironment = environment
    childEnvironment["INK_BRAIN_HELPER_CHILD"] = "1"
    let argv: [UnsafeMutablePointer<CChar>?] = CommandLine.arguments.map { strdup($0) } + [nil]
    let envp: [UnsafeMutablePointer<CChar>?] = childEnvironment.map { strdup("\($0.key)=\($0.value)") } + [nil]
    var pid: pid_t = 0
    guard posix_spawn(&pid, executable, nil, &attributes, argv, envp) == 0 else { return }
    spawnedChild = pid
    for sig in [SIGTERM, SIGINT, SIGHUP] {
        signal(sig) { received in
            if spawnedChild > 0 { kill(spawnedChild, received) }
            _exit(0)
        }
    }
    var status: Int32 = 0
    while waitpid(pid, &status, 0) == -1 && errno == EINTR {}
    exit((status & 0x7f) == 0 ? (status >> 8) & 0xff : 1)
}

// MARK: - Permissions

enum Permissions {
    static func status() -> [String: Any] {
        [
            "screen": CGPreflightScreenCaptureAccess() ? "granted" : "missing",
            "control": CGPreflightPostEventAccess() ? "granted" : "missing",
            "microphone": name(AVCaptureDevice.authorizationStatus(for: .audio)),
            "speech": name(SFSpeechRecognizer.authorizationStatus()),
        ]
    }

    static func request(_ args: [String: Any], completion: @escaping ([String: Any]) -> Void) {
        let group = DispatchGroup()
        if args["screen"] as? Bool == true && !CGPreflightScreenCaptureAccess() {
            _ = CGRequestScreenCaptureAccess()
        }
        if args["control"] as? Bool == true && !CGPreflightPostEventAccess() {
            _ = CGRequestPostEventAccess()
        }
        if args["microphone"] as? Bool == true && AVCaptureDevice.authorizationStatus(for: .audio) == .notDetermined {
            group.enter()
            AVCaptureDevice.requestAccess(for: .audio) { _ in group.leave() }
        }
        if args["speech"] as? Bool == true && SFSpeechRecognizer.authorizationStatus() == .notDetermined {
            group.enter()
            SFSpeechRecognizer.requestAuthorization { _ in group.leave() }
        }
        group.notify(queue: .main) { completion(status()) }
    }

    // Ensures speech recognition (and optionally microphone) access, prompting when undetermined.
    static func ensure(microphone: Bool, completion: @escaping (Error?) -> Void) {
        func speech() {
            switch SFSpeechRecognizer.authorizationStatus() {
            case .authorized:
                completion(nil)
            case .notDetermined:
                SFSpeechRecognizer.requestAuthorization { status in
                    DispatchQueue.main.async {
                        completion(status == .authorized ? nil : HelperError("Speech recognition permission was not granted."))
                    }
                }
            default:
                completion(HelperError("Speech recognition is off for Ink Brain Helper. Enable it in System Settings > Privacy & Security > Speech Recognition."))
            }
        }
        guard microphone else { return speech() }
        switch AVCaptureDevice.authorizationStatus(for: .audio) {
        case .authorized:
            speech()
        case .notDetermined:
            AVCaptureDevice.requestAccess(for: .audio) { granted in
                DispatchQueue.main.async {
                    granted ? speech() : completion(HelperError("Microphone permission was not granted."))
                }
            }
        default:
            completion(HelperError("Microphone access is off for Ink Brain Helper. Enable it in System Settings > Privacy & Security > Microphone."))
        }
    }

    private static func name(_ status: AVAuthorizationStatus) -> String {
        switch status {
        case .authorized: return "granted"
        case .denied: return "denied"
        case .restricted: return "restricted"
        case .notDetermined: return "prompt"
        @unknown default: return "unknown"
        }
    }

    private static func name(_ status: SFSpeechRecognizerAuthorizationStatus) -> String {
        switch status {
        case .authorized: return "granted"
        case .denied: return "denied"
        case .restricted: return "restricted"
        case .notDetermined: return "prompt"
        @unknown default: return "unknown"
        }
    }
}

// MARK: - Screen capture

enum ScreenCapture {
    static func capture(id: Any, args: [String: Any]) async {
        do {
            let content = try await SCShareableContent.excludingDesktopWindows(false, onScreenWindowsOnly: true)
            let wanted = (args["displayId"] as? NSNumber)?.uint32Value ?? CGMainDisplayID()
            guard let display = content.displays.first(where: { $0.displayID == wanted }) ?? content.displays.first else {
                throw HelperError("No display is available to capture.")
            }
            let hidden = Set((args["excludePids"] as? [NSNumber] ?? []).map(\.int32Value))
            let excluded = content.applications.filter { hidden.contains($0.processID) }
            let filter = SCContentFilter(display: display, excludingApplications: excluded, exceptingWindows: [])
            let scale = CGFloat(filter.pointPixelScale)
            let config = SCStreamConfiguration()
            var points = filter.contentRect.size
            // An optional region, in display points, captured at full resolution.
            if let rect = args["rect"] as? [String: Any],
               let x = (rect["x"] as? NSNumber)?.doubleValue, let y = (rect["y"] as? NSNumber)?.doubleValue,
               let w = (rect["w"] as? NSNumber)?.doubleValue, let h = (rect["h"] as? NSNumber)?.doubleValue, w >= 1, h >= 1 {
                config.sourceRect = CGRect(x: x, y: y, width: w, height: h)
                points = CGSize(width: w, height: h)
            }
            var width = Int(points.width * scale)
            var height = Int(points.height * scale)
            if let maxEdge = (args["maxLongEdge"] as? NSNumber)?.intValue, maxEdge > 0, max(width, height) > maxEdge {
                let factor = Double(maxEdge) / Double(max(width, height))
                width = Int((Double(width) * factor).rounded())
                height = Int((Double(height) * factor).rounded())
            }
            config.width = width
            config.height = height
            config.showsCursor = args["showsCursor"] as? Bool ?? true
            let image = try await SCScreenshotManager.captureImage(contentFilter: filter, configuration: config)
            let png = (args["format"] as? String) == "png"
            let quality = (args["quality"] as? NSNumber)?.doubleValue ?? 0.88
            guard let data = encode(image, png: png, quality: quality) else {
                throw HelperError("Could not encode the screenshot.")
            }
            Out.reply(id, [
                "data": data.base64EncodedString(),
                "mime": png ? "image/png" : "image/jpeg",
                "width": image.width,
                "height": image.height,
                "pointWidth": Double(points.width),
                "pointHeight": Double(points.height),
                "displayId": Int(display.displayID),
            ])
        } catch {
            Out.fail(id, "Screen capture failed: \(error.localizedDescription)")
        }
    }

    static func encode(_ image: CGImage, png: Bool, quality: Double) -> Data? {
        let data = NSMutableData()
        let type = (png ? UTType.png : UTType.jpeg).identifier as CFString
        guard let destination = CGImageDestinationCreateWithData(data, type, 1, nil) else { return nil }
        CGImageDestinationAddImage(destination, image, [kCGImageDestinationLossyCompressionQuality: quality] as CFDictionary)
        return CGImageDestinationFinalize(destination) ? data as Data : nil
    }
}

// MARK: - App context

enum AppContext {
    static func frontmost(excluding pids: [Int]) -> [String: Any] {
        let skip = Set(pids)
        let windows = (CGWindowListCopyWindowInfo([.optionOnScreenOnly, .excludeDesktopElements], kCGNullWindowID) as? [[String: Any]]) ?? []
        let normal = windows.filter {
            ($0[kCGWindowLayer as String] as? Int) == 0 && !skip.contains(($0[kCGWindowOwnerPID as String] as? Int) ?? -1)
        }
        var app = NSWorkspace.shared.frontmostApplication
        if let current = app, skip.contains(Int(current.processIdentifier)) { app = nil }
        if app == nil, let pid = normal.first?[kCGWindowOwnerPID as String] as? Int {
            app = NSRunningApplication(processIdentifier: pid_t(pid))
        }
        guard let app else { return [:] }
        var info: [String: Any] = [
            "app": app.localizedName ?? "",
            "bundleId": app.bundleIdentifier ?? "",
            "pid": Int(app.processIdentifier),
        ]
        let window = normal.first { ($0[kCGWindowOwnerPID as String] as? Int) == Int(app.processIdentifier) }
        if let title = window?[kCGWindowName as String] as? String, !title.isEmpty { info["title"] = title }
        return info
    }
}

// Streams the on-screen app windows, front to back, whenever they change, so drawings can stay with their page.
enum WindowWatch {
    private static var timer: Timer?
    private static var skip = Set<Int>()
    private static var last = ""

    static func start(_ args: [String: Any]) {
        skip = Set((args["excludePids"] as? [NSNumber] ?? []).map(\.intValue))
        if timer == nil {
            let center = NSWorkspace.shared.notificationCenter
            for name in [NSWorkspace.didActivateApplicationNotification, NSWorkspace.activeSpaceDidChangeNotification] {
                center.addObserver(forName: name, object: nil, queue: .main) { _ in tick() }
            }
        }
        timer?.invalidate()
        let interval = max(100, (args["intervalMs"] as? NSNumber)?.doubleValue ?? 250) / 1000
        timer = Timer.scheduledTimer(withTimeInterval: interval, repeats: true) { _ in tick() }
        last = ""
        tick()
    }

    static func tick() {
        let info = (CGWindowListCopyWindowInfo([.optionOnScreenOnly, .excludeDesktopElements], kCGNullWindowID) as? [[String: Any]]) ?? []
        var windows: [[String: Any]] = []
        for window in info where windows.count < 40 {
            guard (window[kCGWindowLayer as String] as? Int) == 0,
                  let pid = window[kCGWindowOwnerPID as String] as? Int, !skip.contains(pid),
                  let id = window[kCGWindowNumber as String] as? Int,
                  let bounds = window[kCGWindowBounds as String] as? [String: Any],
                  let rect = CGRect(dictionaryRepresentation: bounds as CFDictionary),
                  rect.width >= 60, rect.height >= 40,
                  (window[kCGWindowAlpha as String] as? Double ?? 1) > 0.05 else { continue }
            windows.append([
                "id": id, "pid": pid, "title": window[kCGWindowName as String] as? String ?? "",
                "x": Double(rect.minX), "y": Double(rect.minY), "w": Double(rect.width), "h": Double(rect.height),
            ])
        }
        guard let data = try? JSONSerialization.data(withJSONObject: windows, options: .sortedKeys),
              let signature = String(data: data, encoding: .utf8), signature != last else { return }
        last = signature
        Out.event("windows", ["windows": windows])
    }
}

// MARK: - Speech recognition

func makeTranscriber(prefix: String, args: [String: Any]) throws -> Transcriber {
    let identifier = args["locale"] as? String ?? Locale.current.identifier
    guard let recognizer = SFSpeechRecognizer(locale: Locale(identifier: identifier)) ?? SFSpeechRecognizer(locale: Locale(identifier: "en-US")) else {
        throw HelperError("Speech recognition is unavailable for \(identifier).")
    }
    let allowServer = args["allowServer"] as? Bool ?? false
    if !recognizer.supportsOnDeviceRecognition && !allowServer {
        throw HelperError("On-device speech recognition is unavailable for \(recognizer.locale.identifier). Turn on Dictation in System Settings > Keyboard to download it, or set allowServerSpeech in ~/.ink-brain/config.json.")
    }
    let silence = ((args["silenceMs"] as? NSNumber)?.doubleValue ?? 1100) / 1000
    return Transcriber(prefix: prefix, recognizer: recognizer, onDevice: recognizer.supportsOnDeviceRecognition, silence: silence)
}

// Streams audio buffers into rolling recognition tasks and emits <prefix>.partial / <prefix>.final events.
final class Transcriber {
    private let prefix: String
    private let recognizer: SFSpeechRecognizer
    private let onDevice: Bool
    private let silence: TimeInterval
    private let lock = NSLock()
    private var request: SFSpeechAudioBufferRecognitionRequest?
    private var task: SFSpeechRecognitionTask?
    private var generation = 0
    private var text = ""
    private var startedAt = Date()
    private var silenceTimer: DispatchWorkItem?
    private var failures = 0
    private(set) var active = false
    private(set) var paused = false

    init(prefix: String, recognizer: SFSpeechRecognizer, onDevice: Bool, silence: TimeInterval) {
        self.prefix = prefix
        self.recognizer = recognizer
        self.onDevice = onDevice
        self.silence = silence
    }

    func start() {
        active = true
        paused = false
        begin()
    }

    func stop(flush: Bool) {
        if flush { emitFinal() }
        active = false
        reset()
    }

    func setPaused(_ value: Bool) {
        guard active, value != paused else { return }
        paused = value
        if value {
            emitFinal()
            reset()
        } else {
            begin()
        }
    }

    // Called from audio threads.
    func append(_ buffer: AVAudioPCMBuffer) {
        lock.lock()
        defer { lock.unlock() }
        request?.append(buffer)
    }

    private func begin() {
        reset()
        guard active, !paused else { return }
        let request = SFSpeechAudioBufferRecognitionRequest()
        request.shouldReportPartialResults = true
        request.requiresOnDeviceRecognition = onDevice
        request.addsPunctuation = true
        request.taskHint = .dictation
        request.contextualStrings = ["Ink Brain", "GitHub", "Copilot"]
        lock.lock()
        self.request = request
        lock.unlock()
        startedAt = Date()
        let current = generation
        task = recognizer.recognitionTask(with: request) { [weak self] result, error in
            DispatchQueue.main.async { self?.handle(result, error, current) }
        }
    }

    private func reset() {
        generation += 1
        silenceTimer?.cancel()
        silenceTimer = nil
        task?.cancel()
        task = nil
        lock.lock()
        request?.endAudio()
        request = nil
        lock.unlock()
        text = ""
    }

    private func handle(_ result: SFSpeechRecognitionResult?, _ error: Error?, _ current: Int) {
        guard current == generation else { return }
        if let result {
            failures = 0
            let latest = result.bestTranscription.formattedString
            if !latest.isEmpty && latest != text {
                text = latest
                Out.event("\(prefix).partial", ["text": latest])
                armSilenceTimer()
            }
            if result.isFinal || Date().timeIntervalSince(startedAt) > 50 { return finishSegment() }
        }
        guard let error else { return }
        // Tasks end after long silences or about a minute; roll over to a fresh one.
        if !text.isEmpty { return finishSegment() }
        let code = (error as NSError).code
        failures += 1
        if ![1110, 216, 209, 301, 1101].contains(code) {
            Out.event("\(prefix).error", ["message": error.localizedDescription, "code": code])
        }
        if failures > 8 {
            Out.event("\(prefix).error", ["message": "Speech recognition keeps failing; stopped listening.", "fatal": true])
            active = false
            return reset()
        }
        DispatchQueue.main.asyncAfter(deadline: .now() + 0.25 * Double(failures)) { [weak self] in
            guard let self, current == self.generation else { return }
            self.begin()
        }
    }

    private func armSilenceTimer() {
        silenceTimer?.cancel()
        let current = generation
        let item = DispatchWorkItem { [weak self] in
            guard let self, current == self.generation else { return }
            self.finishSegment()
        }
        silenceTimer = item
        DispatchQueue.main.asyncAfter(deadline: .now() + silence, execute: item)
    }

    private func finishSegment() {
        emitFinal()
        begin()
    }

    private func emitFinal() {
        let final = text.trimmingCharacters(in: .whitespacesAndNewlines)
        text = ""
        if !final.isEmpty { Out.event("\(prefix).final", ["text": final]) }
    }
}

// MARK: - Microphone

final class Microphone {
    static let shared = Microphone()
    private let engine = AVAudioEngine()
    private var transcriber: Transcriber?
    private var lastLevel = Date.distantPast

    func start(_ args: [String: Any], completion: @escaping (Error?) -> Void) {
        if transcriber != nil { return completion(nil) }
        Permissions.ensure(microphone: true) { error in
            if let error { return completion(error) }
            do {
                try self.begin(args)
                completion(nil)
            } catch {
                completion(error)
            }
        }
    }

    private func begin(_ args: [String: Any]) throws {
        let transcriber = try makeTranscriber(prefix: "stt", args: args)
        let input = engine.inputNode
        let format = input.outputFormat(forBus: 0)
        guard format.sampleRate > 0, format.channelCount > 0 else { throw HelperError("No microphone input is available.") }
        input.removeTap(onBus: 0)
        input.installTap(onBus: 0, bufferSize: 1024, format: format) { [weak self, weak transcriber] buffer, _ in
            transcriber?.append(buffer)
            self?.meter(buffer)
        }
        engine.prepare()
        try engine.start()
        self.transcriber = transcriber
        transcriber.start()
        if SpeechOutput.isBusy { transcriber.setPaused(true) }
        Out.event("stt.state", ["listening": true])
    }

    func stop(flush: Bool) {
        guard let transcriber else { return }
        transcriber.stop(flush: flush)
        engine.inputNode.removeTap(onBus: 0)
        engine.stop()
        self.transcriber = nil
        Out.event("stt.state", ["listening": false])
    }

    func setPaused(_ paused: Bool) {
        transcriber?.setPaused(paused)
    }

    // Runs on the audio thread.
    private func meter(_ buffer: AVAudioPCMBuffer) {
        let now = Date()
        guard now.timeIntervalSince(lastLevel) > 0.066, let samples = buffer.floatChannelData?[0] else { return }
        lastLevel = now
        let count = Int(buffer.frameLength)
        guard count > 0 else { return }
        var sum: Float = 0
        for index in 0..<count { sum += samples[index] * samples[index] }
        Out.event("stt.level", ["level": Double(min(1, sqrt(sum / Float(count)) * 8))])
    }
}

// MARK: - System audio ("Hear my screen")

final class SystemAudio: NSObject, SCStreamOutput, SCStreamDelegate {
    static let shared = SystemAudio()
    private var stream: SCStream?
    private var transcriber: Transcriber?
    private let sinkLock = NSLock()
    private var sink: Transcriber?
    private let queue = DispatchQueue(label: "ink-brain.system-audio")

    func start(_ args: [String: Any]) async throws {
        if stream != nil { return }
        try await withCheckedThrowingContinuation { (continuation: CheckedContinuation<Void, Error>) in
            Permissions.ensure(microphone: false) { error in
                if let error { continuation.resume(throwing: error) } else { continuation.resume() }
            }
        }
        let transcriber = try makeTranscriber(prefix: "hear", args: args)
        let content = try await SCShareableContent.excludingDesktopWindows(false, onScreenWindowsOnly: true)
        guard let display = content.displays.first(where: { $0.displayID == CGMainDisplayID() }) ?? content.displays.first else {
            throw HelperError("No display is available for audio capture.")
        }
        let filter = SCContentFilter(display: display, excludingApplications: [], exceptingWindows: [])
        let config = SCStreamConfiguration()
        config.capturesAudio = true
        config.excludesCurrentProcessAudio = true
        config.sampleRate = 16_000
        config.channelCount = 1
        config.width = 2
        config.height = 2
        config.minimumFrameInterval = CMTime(value: 1, timescale: 2)
        config.showsCursor = false
        let stream = SCStream(filter: filter, configuration: config, delegate: self)
        try stream.addStreamOutput(self, type: .audio, sampleHandlerQueue: queue)
        try stream.addStreamOutput(self, type: .screen, sampleHandlerQueue: queue)
        try await stream.startCapture()
        self.stream = stream
        self.transcriber = transcriber
        setSink(transcriber)
        transcriber.start()
        if SpeechOutput.isBusy { transcriber.setPaused(true) }
        Out.event("hear.state", ["hearing": true])
    }

    func stop(error: Error? = nil) {
        guard let stream else { return }
        setSink(nil)
        transcriber?.stop(flush: true)
        transcriber = nil
        self.stream = nil
        stream.stopCapture { _ in }
        var fields: [String: Any] = ["hearing": false]
        if let error { fields["error"] = error.localizedDescription }
        Out.event("hear.state", fields)
    }

    func setPaused(_ paused: Bool) {
        transcriber?.setPaused(paused)
    }

    private func setSink(_ value: Transcriber?) {
        sinkLock.lock()
        sink = value
        sinkLock.unlock()
    }

    func stream(_ stream: SCStream, didOutputSampleBuffer sampleBuffer: CMSampleBuffer, of type: SCStreamOutputType) {
        guard type == .audio, sampleBuffer.isValid, let buffer = SystemAudio.pcm(sampleBuffer) else { return }
        sinkLock.lock()
        let target = sink
        sinkLock.unlock()
        target?.append(buffer)
    }

    func stream(_ stream: SCStream, didStopWithError error: Error) {
        DispatchQueue.main.async { self.stop(error: error) }
    }

    private static func pcm(_ sampleBuffer: CMSampleBuffer) -> AVAudioPCMBuffer? {
        guard var description = sampleBuffer.formatDescription?.audioStreamBasicDescription,
              let format = AVAudioFormat(streamDescription: &description) else { return nil }
        let frames = AVAudioFrameCount(sampleBuffer.numSamples)
        guard frames > 0, let buffer = AVAudioPCMBuffer(pcmFormat: format, frameCapacity: frames) else { return nil }
        buffer.frameLength = frames
        let status = CMSampleBufferCopyPCMDataIntoAudioBufferList(sampleBuffer, at: 0, frameCount: Int32(frames), into: buffer.mutableAudioBufferList)
        return status == noErr ? buffer : nil
    }
}

// MARK: - Speech output

// All state is touched on the main thread; delegate callbacks hop there first.
final class Speaker: NSObject, AVSpeechSynthesizerDelegate, @unchecked Sendable {
    static let shared = Speaker()
    private let synthesizer = AVSpeechSynthesizer()
    // Ids in speaking order; delegate callbacks receive copies of utterances, so identity cannot be used.
    private var queue: [String] = []

    var isBusy: Bool { !queue.isEmpty }

    override init() {
        super.init()
        synthesizer.delegate = self
    }

    func speak(_ args: [String: Any]) {
        guard let text = args["text"] as? String, !text.isEmpty else { return }
        let utterance = AVSpeechUtterance(string: text)
        utterance.voice = Speaker.voice(args["voice"] as? String)
        if let rate = (args["rate"] as? NSNumber)?.floatValue { utterance.rate = rate }
        if let volume = (args["volume"] as? NSNumber)?.floatValue { utterance.volume = volume }
        queue.append(args["utterance"] as? String ?? "")
        SpeechOutput.began()
        synthesizer.speak(utterance)
    }

    func stop() {
        synthesizer.stopSpeaking(at: .immediate)
    }

    func speechSynthesizer(_ synthesizer: AVSpeechSynthesizer, didStart utterance: AVSpeechUtterance) {
        DispatchQueue.main.async { Out.event("tts.start", ["utterance": self.queue.first ?? ""]) }
    }

    func speechSynthesizer(_ synthesizer: AVSpeechSynthesizer, didFinish utterance: AVSpeechUtterance) {
        DispatchQueue.main.async { self.finished(cancelled: false) }
    }

    func speechSynthesizer(_ synthesizer: AVSpeechSynthesizer, didCancel utterance: AVSpeechUtterance) {
        DispatchQueue.main.async { self.finished(cancelled: true) }
    }

    private func finished(cancelled: Bool) {
        let utterance = queue.isEmpty ? "" : queue.removeFirst()
        Out.event("tts.end", ["utterance": utterance, "cancelled": cancelled, "idle": !SpeechOutput.isBusy])
        SpeechOutput.settled()
    }

    static func voice(_ identifier: String?) -> AVSpeechSynthesisVoice? {
        if let identifier, let voice = AVSpeechSynthesisVoice(identifier: identifier) { return voice }
        let language = AVSpeechSynthesisVoice.currentLanguageCode()
        let candidates = AVSpeechSynthesisVoice.speechVoices().filter {
            $0.language == language && !$0.voiceTraits.contains(.isNoveltyVoice)
        }
        return candidates.first { $0.quality == .premium }
            ?? candidates.first { $0.quality == .enhanced }
            ?? AVSpeechSynthesisVoice(language: language)
    }

    static func voices() -> [[String: Any]] {
        AVSpeechSynthesisVoice.speechVoices().filter { $0.language.hasPrefix("en") }.map {
            [
                "id": $0.identifier,
                "name": $0.name,
                "language": $0.language,
                "quality": $0.quality == .premium ? "premium" : $0.quality == .enhanced ? "enhanced" : "default",
            ]
        }
    }
}

// MARK: - Speech output coordination and neural voice playback

// Keeps microphones paused while either speech output is talking.
enum SpeechOutput {
    private static var resumeWork: DispatchWorkItem?

    static var isBusy: Bool { Speaker.shared.isBusy || Player.shared.isBusy }

    static func began() {
        resumeWork?.cancel()
        Microphone.shared.setPaused(true)
        SystemAudio.shared.setPaused(true)
    }

    // Let the room go quiet before listening again so we do not transcribe ourselves.
    static func settled() {
        guard !isBusy else { return }
        let work = DispatchWorkItem {
            Microphone.shared.setPaused(false)
            SystemAudio.shared.setPaused(false)
            Player.shared.idle()
        }
        resumeWork = work
        DispatchQueue.main.asyncAfter(deadline: .now() + 0.35, execute: work)
    }
}

// Plays 16-bit mono PCM produced by the neural voice, in order, with the same tts events as the system voice.
final class Player: @unchecked Sendable {
    static let shared = Player()
    private let engine = AVAudioEngine()
    private let node = AVAudioPlayerNode()
    private var format: AVAudioFormat?
    private var queue: [String] = []
    private var generation = 0
    private var pauseWork: DispatchWorkItem?

    var isBusy: Bool { !queue.isEmpty }

    func play(_ args: [String: Any]) throws {
        guard let base64 = args["pcm"] as? String, let pcm = Data(base64Encoded: base64), pcm.count >= 2 else {
            throw HelperError("No audio to play.")
        }
        let format = try prepare((args["sampleRate"] as? NSNumber)?.doubleValue ?? 24_000)
        let frames = pcm.count / 2
        guard let buffer = AVAudioPCMBuffer(pcmFormat: format, frameCapacity: AVAudioFrameCount(frames)), let out = buffer.floatChannelData?[0] else {
            throw HelperError("Could not allocate an audio buffer.")
        }
        buffer.frameLength = AVAudioFrameCount(frames)
        pcm.withUnsafeBytes { raw in
            let samples = raw.bindMemory(to: Int16.self)
            for index in 0..<frames { out[index] = Float(Int16(littleEndian: samples[index])) / 32768 }
        }
        pauseWork?.cancel()
        node.volume = (args["volume"] as? NSNumber)?.floatValue ?? 1
        if !engine.isRunning { try engine.start() }
        let utterance = args["utterance"] as? String ?? ""
        let current = generation
        queue.append(utterance)
        SpeechOutput.began()
        node.scheduleBuffer(buffer, completionCallbackType: .dataPlayedBack) { [weak self] _ in
            DispatchQueue.main.async { self?.finished(current) }
        }
        if !node.isPlaying { node.play() }
        if queue.count == 1 { Out.event("tts.start", ["utterance": utterance]) }
    }

    func stop() {
        generation += 1
        node.stop()
        let dropped = queue
        queue = []
        for (index, utterance) in dropped.enumerated() {
            Out.event("tts.end", ["utterance": utterance, "cancelled": true, "idle": index == dropped.count - 1 && !SpeechOutput.isBusy])
        }
        SpeechOutput.settled()
    }

    // Releases the audio device a while after the last sentence.
    func idle() {
        pauseWork?.cancel()
        let work = DispatchWorkItem { [weak self] in
            guard let self, self.queue.isEmpty, self.engine.isRunning else { return }
            self.engine.pause()
        }
        pauseWork = work
        DispatchQueue.main.asyncAfter(deadline: .now() + 8, execute: work)
    }

    private func prepare(_ sampleRate: Double) throws -> AVAudioFormat {
        if let format, format.sampleRate == sampleRate { return format }
        guard let format = AVAudioFormat(standardFormatWithSampleRate: sampleRate, channels: 1) else {
            throw HelperError("Unsupported sample rate \(sampleRate).")
        }
        if engine.isRunning { engine.stop() }
        if node.engine == nil { engine.attach(node) }
        engine.connect(node, to: engine.mainMixerNode, format: format)
        engine.prepare()
        self.format = format
        return format
    }

    private func finished(_ playedGeneration: Int) {
        guard playedGeneration == generation, !queue.isEmpty else { return }
        let utterance = queue.removeFirst()
        Out.event("tts.end", ["utterance": utterance, "cancelled": false, "idle": !SpeechOutput.isBusy])
        if let next = queue.first { Out.event("tts.start", ["utterance": next]) }
        SpeechOutput.settled()
    }
}

// MARK: - Input (only used after the user approves Copilot taking control)

enum Input {
    private static let source = CGEventSource(stateID: .hidSystemState)

    static var allowed: Bool { CGPreflightPostEventAccess() }

    static func cursor() -> CGPoint { CGEvent(source: nil)?.location ?? .zero }

    private static func post(_ event: CGEvent?) { event?.post(tap: .cghidEventTap) }

    private static func number(_ value: Any?) -> Double { (value as? NSNumber)?.doubleValue ?? 0 }

    static func perform(_ args: [String: Any]) throws {
        guard allowed else {
            throw HelperError("Ink Brain Helper is not allowed to control your Mac. Turn it on in System Settings > Privacy & Security > Accessibility.")
        }
        let action = args["action"] as? String ?? ""
        let hasPoint = args["x"] is NSNumber && args["y"] is NSNumber
        let point = CGPoint(x: number(args["x"]), y: number(args["y"]))
        switch action {
        case "move":
            move(to: point, duration: 0.35)
        case "click", "double_click", "right_click":
            move(to: point, duration: 0.35)
            usleep(60_000)
            click(at: point, button: action == "right_click" ? .right : .left, count: action == "double_click" ? 2 : 1)
        case "drag":
            drag(from: point, to: CGPoint(x: number(args["toX"]), y: number(args["toY"])))
        case "scroll":
            if hasPoint { move(to: point, duration: 0.25) }
            scroll(dx: Int(number(args["dx"])), dy: Int(number(args["dy"])))
        case "type":
            type(args["text"] as? String ?? "")
        case "key":
            try key(args["keys"] as? String ?? "")
        default:
            throw HelperError("Unknown action \"\(action)\".")
        }
    }

    private static func move(to target: CGPoint, duration: Double, button: CGMouseButton? = nil) {
        let start = cursor()
        let steps = max(1, Int(duration * 90))
        let type: CGEventType = button == nil ? .mouseMoved : (button == .right ? .rightMouseDragged : .leftMouseDragged)
        for step in 1...steps {
            let t = Double(step) / Double(steps)
            let eased = t < 0.5 ? 2 * t * t : 1 - pow(-2 * t + 2, 2) / 2
            let point = CGPoint(x: start.x + (target.x - start.x) * eased, y: start.y + (target.y - start.y) * eased)
            post(CGEvent(mouseEventSource: source, mouseType: type, mouseCursorPosition: point, mouseButton: button ?? .left))
            usleep(useconds_t(duration * 1_000_000 / Double(steps)))
        }
    }

    private static func click(at point: CGPoint, button: CGMouseButton, count: Int) {
        let (down, up): (CGEventType, CGEventType) = button == .right ? (.rightMouseDown, .rightMouseUp) : (.leftMouseDown, .leftMouseUp)
        for clickState in 1...count {
            for type in [down, up] {
                let event = CGEvent(mouseEventSource: source, mouseType: type, mouseCursorPosition: point, mouseButton: button)
                event?.setIntegerValueField(.mouseEventClickState, value: Int64(clickState))
                post(event)
                usleep(35_000)
            }
        }
    }

    private static func drag(from start: CGPoint, to end: CGPoint) {
        move(to: start, duration: 0.25)
        post(CGEvent(mouseEventSource: source, mouseType: .leftMouseDown, mouseCursorPosition: start, mouseButton: .left))
        usleep(80_000)
        move(to: end, duration: 0.6, button: .left)
        post(CGEvent(mouseEventSource: source, mouseType: .leftMouseUp, mouseCursorPosition: end, mouseButton: .left))
    }

    private static func scroll(dx: Int, dy: Int) {
        var (remainingX, remainingY) = (dx, dy)
        while remainingX != 0 || remainingY != 0 {
            let stepX = max(-120, min(120, remainingX))
            let stepY = max(-120, min(120, remainingY))
            post(CGEvent(scrollWheelEvent2Source: source, units: .pixel, wheelCount: 2, wheel1: Int32(-stepY), wheel2: Int32(-stepX), wheel3: 0))
            remainingX -= stepX
            remainingY -= stepY
            usleep(16_000)
        }
    }

    private static func type(_ text: String) {
        for (index, line) in text.components(separatedBy: "\n").enumerated() {
            if index > 0 { try? key("return") }
            let characters = Array(line)
            for start in stride(from: 0, to: characters.count, by: 8) {
                let chunk = Array(String(characters[start..<min(start + 8, characters.count)]).utf16)
                for down in [true, false] {
                    let event = CGEvent(keyboardEventSource: source, virtualKey: 0, keyDown: down)
                    event?.keyboardSetUnicodeString(stringLength: chunk.count, unicodeString: chunk)
                    post(event)
                }
                usleep(15_000)
            }
        }
    }

    private static let keyCodes: [String: CGKeyCode] = [
        "a": 0, "s": 1, "d": 2, "f": 3, "h": 4, "g": 5, "z": 6, "x": 7, "c": 8, "v": 9, "b": 11, "q": 12, "w": 13, "e": 14, "r": 15,
        "y": 16, "t": 17, "1": 18, "2": 19, "3": 20, "4": 21, "6": 22, "5": 23, "=": 24, "9": 25, "7": 26, "-": 27, "8": 28, "0": 29,
        "]": 30, "o": 31, "u": 32, "[": 33, "i": 34, "p": 35, "l": 37, "j": 38, "'": 39, "k": 40, ";": 41, "\\": 42, ",": 43,
        "/": 44, "n": 45, "m": 46, ".": 47, "`": 50,
        "return": 36, "enter": 36, "tab": 48, "space": 49, "delete": 51, "backspace": 51, "escape": 53, "esc": 53,
        "forwarddelete": 117, "home": 115, "end": 119, "pageup": 116, "pagedown": 121,
        "left": 123, "right": 124, "down": 125, "up": 126,
        "f1": 122, "f2": 120, "f3": 99, "f4": 118, "f5": 96, "f6": 97, "f7": 98, "f8": 100, "f9": 101, "f10": 109, "f11": 103, "f12": 111,
    ]

    private static func key(_ combo: String) throws {
        var flags: CGEventFlags = []
        var code: CGKeyCode?
        for part in combo.lowercased().split(separator: "+").map({ $0.trimmingCharacters(in: .whitespaces) }) {
            switch part {
            case "cmd", "command", "meta": flags.insert(.maskCommand)
            case "shift": flags.insert(.maskShift)
            case "alt", "option", "opt": flags.insert(.maskAlternate)
            case "ctrl", "control": flags.insert(.maskControl)
            case "fn": flags.insert(.maskSecondaryFn)
            default:
                guard let value = keyCodes[part] else { throw HelperError("Unknown key \"\(part)\" in \"\(combo)\".") }
                code = value
            }
        }
        guard let code else { throw HelperError("No key in \"\(combo)\".") }
        for down in [true, false] {
            let event = CGEvent(keyboardEventSource: source, virtualKey: code, keyDown: down)
            event?.flags = flags
            post(event)
            usleep(20_000)
        }
    }
}

// MARK: - Commands

func handle(_ command: String, id: Any, args: [String: Any]) {
    switch command {
    case "ping":
        let responsible = ProcessInfo.processInfo.environment["INK_BRAIN_HELPER_CHILD"] != nil ? "self" : "inherited"
        Out.reply(id, ["pid": Int(getpid()), "responsible": responsible])
    case "permissions":
        Out.reply(id, Permissions.status())
    case "requestPermissions":
        Permissions.request(args) { Out.reply(id, $0) }
    case "capture":
        Task { await ScreenCapture.capture(id: id, args: args) }
    case "frontmost":
        Out.reply(id, AppContext.frontmost(excluding: (args["excludePids"] as? [NSNumber] ?? []).map(\.intValue)))
    case "windows.watch":
        WindowWatch.start(args)
        Out.reply(id)
    case "activate":
        if let pid = (args["pid"] as? NSNumber)?.int32Value, let app = NSRunningApplication(processIdentifier: pid) {
            app.activate()
        }
        Out.reply(id)
    case "listen.start":
        Microphone.shared.start(args) { error in
            if let error { Out.fail(id, error.localizedDescription) } else { Out.reply(id) }
        }
    case "listen.stop":
        Microphone.shared.stop(flush: args["flush"] as? Bool ?? true)
        Out.reply(id)
    case "speak":
        Speaker.shared.speak(args)
        Out.reply(id)
    case "play":
        do {
            try Player.shared.play(args)
            Out.reply(id)
        } catch {
            Out.fail(id, error.localizedDescription)
        }
    case "speak.stop":
        Speaker.shared.stop()
        Player.shared.stop()
        Out.reply(id)
    case "voices":
        Out.reply(id, Speaker.voices())
    case "input.status":
        let cursor = Input.cursor()
        Out.reply(id, ["allowed": Input.allowed, "x": Double(cursor.x), "y": Double(cursor.y)])
    case "input.request":
        Out.reply(id, ["allowed": CGRequestPostEventAccess()])
    case "input.act":
        DispatchQueue.global(qos: .userInitiated).async {
            do {
                try Input.perform(args)
                let cursor = Input.cursor()
                Out.reply(id, ["x": Double(cursor.x), "y": Double(cursor.y)])
            } catch {
                Out.fail(id, error.localizedDescription)
            }
        }
    case "hear.start":
        Task { @MainActor in
            do {
                try await SystemAudio.shared.start(args)
                Out.reply(id)
            } catch {
                Out.fail(id, error.localizedDescription)
            }
        }
    case "hear.stop":
        SystemAudio.shared.stop()
        Out.reply(id)
    default:
        Out.fail(id, "Unknown command: \(command)")
    }
}

// MARK: - Main

disclaimResponsibilityIfNeeded()

Thread {
    while let line = readLine() {
        guard let data = line.data(using: .utf8),
              let object = (try? JSONSerialization.jsonObject(with: data)) as? [String: Any],
              let command = object["cmd"] as? String else { continue }
        let id = object["id"] ?? NSNull()
        DispatchQueue.main.async { handle(command, id: id, args: object) }
    }
    // The app closed our stdin, so it is gone; exit with it.
    DispatchQueue.main.async { exit(0) }
}.start()

Out.event("ready", ["pid": Int(getpid())])
RunLoop.main.run()
