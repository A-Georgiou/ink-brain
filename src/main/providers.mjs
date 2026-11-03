// Where the built-in session's answers come from: GitHub Copilot, or the user's own OpenAI, Anthropic or local Ollama models.
const OLLAMA = "http://127.0.0.1:11434";

export const PROVIDERS = {
    copilot: { label: "GitHub Copilot" },
    chatgpt: { label: "ChatGPT", page: "https://chatgpt.com/settings/usage", prefer: ["gpt-6.1-terra"] },
    openai: { label: "OpenAI", env: "OPENAI_API_KEY", page: "https://platform.openai.com/api-keys", prefer: ["gpt-6.1-terra"] },
    anthropic: { label: "Claude", env: "ANTHROPIC_API_KEY", page: "https://console.anthropic.com/settings/keys", prefer: [/opus/, /sonnet/] },
    ollama: { label: "Ollama", page: "https://ollama.com/download" },
};

// The Copilot SDK's bring-your-own-key settings for a provider, or null for Copilot itself.
export function sdkProvider(id, key) {
    if (id === "openai") return { type: "openai", baseUrl: "https://api.openai.com/v1", wireApi: "responses", apiKey: key };
    if (id === "anthropic") return { type: "anthropic", baseUrl: "https://api.anthropic.com", apiKey: key };
    if (id === "ollama") return { type: "openai", baseUrl: `${OLLAMA}/v1` };
    return null;
}

async function getJson(url, init, label, fetchImpl) {
    let response;
    try {
        response = await fetchImpl(url, { ...init, signal: AbortSignal.timeout(8_000) });
    } catch {
        throw new Error(label === "Ollama" ? "Ollama is not running. Open the Ollama app, then check again." : `Could not reach ${label}. Check your connection.`);
    }
    if (response.status === 401 || response.status === 403) throw new Error(`${label} did not accept that API key.`);
    if (!response.ok) throw new Error(`${label} answered with error ${response.status}.`);
    return response.json();
}

// The provider's models that can see the screen, newest first.
export async function listModels(id, key, fetchImpl = fetch) {
    if (id === "openai") {
        const { data = [] } = await getJson("https://api.openai.com/v1/models", { headers: { authorization: `Bearer ${key}` } }, "OpenAI", fetchImpl);
        const chat = data.filter(({ id: model }) => /^(gpt-|o\d)/.test(model) && !/audio|realtime|transcribe|tts|image|search|embed|instruct/.test(model));
        return chat.sort((a, b) => (b.created ?? 0) - (a.created ?? 0)).map(({ id: model }) => model);
    }
    if (id === "anthropic") {
        const { data = [] } = await getJson("https://api.anthropic.com/v1/models?limit=100", { headers: { "x-api-key": key, "anthropic-version": "2023-06-01" } }, "Anthropic", fetchImpl);
        return data.map(({ id: model }) => model);
    }
    if (id === "ollama") {
        const { models = [] } = await getJson(`${OLLAMA}/api/tags`, {}, "Ollama", fetchImpl);
        const show = ({ name }) => getJson(`${OLLAMA}/api/show`, { method: "POST", body: JSON.stringify({ model: name }) }, "Ollama", fetchImpl).then(({ capabilities = [] }) => (capabilities.includes("vision") && capabilities.includes("tools") ? name : null), () => null);
        return (await Promise.all(models.map(show))).filter(Boolean);
    }
    return [];
}

// The wanted model if the provider has it, else its preferred family, else its newest.
export function pickModel(id, models, wanted) {
    if (models.includes(wanted)) return wanted;
    for (const want of PROVIDERS[id]?.prefer ?? []) {
        const hit = models.find((model) => (typeof want === "string" ? model === want : want.test(model)));
        if (hit) return hit;
    }
    return models[0];
}
