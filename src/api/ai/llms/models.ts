import {CoreMessage, generateText, LanguageModelV1, streamText, ToolResultUnion, ToolSet} from "ai"
import {ChatMessage} from "../../../models/chat/ChatMessage";
import {v4 as uuidv4} from "uuid";
import {groq} from "@ai-sdk/groq";
import {openai} from "@ai-sdk/openai";
import {LlmProvider} from "../../../models/llmProvider";
import {ProviderV1} from "@ai-sdk/provider";
import {Signal, signal} from "../../../ui/lib/fjsc/src/signals";
import {getGroqModels} from "./providers/groq";
import {ModelDefinition} from "../../../models/modelDefinition";
import {getOpenaiModels} from "./providers/openai";

export const providerMap: Record<LlmProvider, ProviderV1> = {
    [LlmProvider.groq]: groq,
    [LlmProvider.openai]: openai
}

export function getModel(providerName: LlmProvider, model: string): LanguageModelV1 {
    const provider = providerMap[providerName];
    if (!provider) {
        throw new Error("Invalid LLM provider");
    }

    return provider.languageModel(model);
}

export async function getAvailableModels(provider: string): Promise<ModelDefinition[]> {
    switch (provider) {
        case LlmProvider.groq:
            return await getGroqModels();
        case LlmProvider.openai:
            return await getOpenaiModels();
        default:
            throw new Error("Unsupported LLM provider");
    }
}

export async function initializeLlms() {
    const availableProviders = Object.values(LlmProvider);
    const models: Record<string, ModelDefinition[]> = {};
    for (const provider of availableProviders) {
        models[provider] = await getAvailableModels(provider);
    }
    return models;
}

export async function tryCallTool(model: LanguageModelV1, messages: CoreMessage[], tools: ToolSet): Promise<Array<ToolResultUnion<ToolSet>>> {
    const res = await generateText({
        model,
        messages,
        tools,
        toolChoice: "auto"
    });

    return res.toolResults;
}

export async function streamResponseAsMessage(model: LanguageModelV1, messages: CoreMessage[]): Promise<Signal<ChatMessage>> {
    const { textStream } = streamText({
        model,
        messages,
        presencePenalty: 0.6,
        frequencyPenalty: 0.6,
        temperature: 0.9,
        maxTokens: 1000,
    });

    const messageId = uuidv4();
    const message = signal<ChatMessage>({
        id: messageId,
        type: "assistant",
        text: "",
        time: Date.now(),
        references: [],
        finished: false
    });

    updateMessageFromStream(message, textStream).then();

    return message;
}

export async function updateMessageFromStream(message: Signal<ChatMessage>, stream: AsyncIterable<string> & ReadableStream<string>) {
    const reader = stream.getReader();

    while (true) {
        const { value, done } = await reader.read();
        const m = message.value;
        if (done) {
            message.value = {
                ...m,
                finished: true
            }
            break;
        }
        message.value = {
            ...m,
            text: m.text + value
        }
    }
}

export async function getSimpleResponse(model: LanguageModelV1, messages: CoreMessage[], maxTokens: number = 1000): Promise<string> {
    const res = await generateText({
        model,
        messages,
        maxTokens
    });

    return res.text;
}