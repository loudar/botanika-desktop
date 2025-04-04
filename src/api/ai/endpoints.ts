import {Application, Request, Response} from "express";
import {ChatMessage} from "../../models/chat/ChatMessage";
import {getAvailableModels, getModel, initializeLlms} from "./llms/models";
import {ChatUpdate} from "../../models/chat/ChatUpdate";
import {terminator} from "../../models/chat/terminator";
import {updateContext} from "../../models/updateContext";
import {createChat, getPromptMessages, getToolPromptMessages, getWorldContext, newUserMessage} from "./llms/messages";
import {ChatContext} from "../../models/chat/ChatContext";
import {ChatStorage} from "../storage/ChatStorage";
import {getMcpTools} from "./initializer";
import {CLI} from "../CLI";
import {LlmProvider} from "../../models/llmProvider";
import {addToolCallsToContext} from "./llms/functions";
import {getTtsAudio} from "./tts/tts";
import {AudioStorage} from "../storage/AudioStorage";
import {getConfig, getConfigKey} from "../configuration";
import {signal} from "../../ui/lib/fjsc/src/signals";
import {getSimpleResponse, streamResponseAsMessage, tryCallTool} from "./llms/calls";
import {v4 as uuidv4} from "uuid";
import {getConfiguredApis} from "../features/configuredFeatures";

export const currentChatContext = signal<ChatContext>(null);

export function chunk(content: string) {
    return `${content}${terminator}`;
}

export async function sendMessages(messages: ChatMessage[], chatContext: ChatContext, res: Response, persist: boolean) {
    const update = <ChatUpdate>{
        chatId: chatContext.id,
        timestamp: Date.now(),
        messages: messages
    };
    res.write(chunk(JSON.stringify(update)));
    chatContext = updateContext(chatContext, update);
    if (persist) {
        await ChatStorage.writeChatContext(chatContext.id, chatContext);
    }
    return chatContext;
}

export const chatEndpoint = async (req: Request, res: Response) => {
    const message = req.body.message as string;
    if (!message) {
        res.status(400).send('Missing message parameter');
        return;
    }

    const provider = req.body.provider ?? "groq";
    const modelName = req.body.model ?? "llama-3.1-8b-instant";

    const availableModels = await getAvailableModels(provider);
    const modelDefinition = availableModels.find(m => m.id === modelName);
    if (!modelDefinition) {
        res.status(404).send('Model not found');
        return;
    }

    res.setHeader('Content-Type', 'text/event-stream');
    res.setHeader('Cache-Control', 'no-cache');
    res.setHeader('Connection', 'keep-alive');
    const model = getModel(provider, modelName);

    let chatId = req.body.chatId;
    let chatContext: ChatContext;
    if (!chatId) {
        CLI.debug(`Creating chat`);
        const chatMsg = newUserMessage(provider, modelName, message);
        chatContext = await createChat(model, chatMsg);
        res.write(chunk(JSON.stringify(<ChatUpdate>{
            chatId,
            timestamp: Date.now(),
            messages: [chatMsg]
        })));
        chatId = chatContext.id;
        CLI.debug(`Chat created`);
    } else {
        CLI.debug(`Getting existing chat`);
        chatContext = await ChatStorage.readChatContext(chatId);
        if (!chatContext) {
            res.status(404).send('Chat not found');
            return;
        }

        chatContext.history.push(newUserMessage(provider, modelName, message));
        res.write(chunk(JSON.stringify(<ChatUpdate>{
            chatId,
            timestamp: Date.now(),
            messages: chatContext.history
        })));
    }

    currentChatContext.value = chatContext;
    if (modelDefinition.supportsTools) {
        const {tools, onClose: onMcpClose} = await getMcpTools();
        function onContextChange(c: ChatContext, changed: boolean) {
            if (changed) {
                const update = <ChatUpdate>{
                    chatId,
                    timestamp: Date.now(),
                    messages: [...c.history]
                };
                res.write(chunk(JSON.stringify(update)));
                chatContext = updateContext(chatContext, update);
            }
        }
        currentChatContext.subscribe(onContextChange);
        const calls = await tryCallTool(model, getToolPromptMessages(chatContext.history), tools);
        currentChatContext.unsubscribe(onContextChange);
        if (calls.length > 0) {
            await addToolCallsToContext(provider, modelName, calls, res, chatContext);
        }
        onMcpClose();
    }

    const worldContext = getWorldContext();
    if (provider === LlmProvider.openrouter) {
        const responseText = await getSimpleResponse(model, getPromptMessages(chatContext.history, worldContext, getConfig()));
        const m = <ChatMessage>{
            id: uuidv4(),
            type: "assistant",
            text: responseText,
            time: Date.now(),
            references: [],
            files: [],
            finished: true,
            provider,
            model: modelName
        };
        await sendMessages([m], chatContext, res, true);
        if (getConfigKey("enableTts") && m.text.length > 0) {
            await sendAudioAndStop(chatContext, m, res);
        } else {
            res.end();
        }
    } else {
        const responseMsg = await streamResponseAsMessage(provider, modelName, model, getPromptMessages(chatContext.history, worldContext, getConfig()));

        responseMsg.subscribe(async (m: ChatMessage) => {
            await sendMessages([m], chatContext, res, false);
            if (m.finished) {
                await sendMessages([m], chatContext, res, true);
                if (getConfigKey("enableTts") && m.text.length > 0) {
                    await sendAudioAndStop(chatContext, m, res);
                } else {
                    res.end();
                }
            }
        });
    }

    req.on('close', () => {
        console.log(`Client disconnected from updates for chatId: ${chatId}`);
        res.end();
    });
};

export async function getAudio(lastMessage: ChatMessage): Promise<string> {
    if (lastMessage.type === "assistant") {
        const blob = await getTtsAudio(lastMessage.text);
        await AudioStorage.writeAudio(lastMessage.id, blob);
        return AudioStorage.getLocalFileUrl(lastMessage.id);
    }

    return null;
}

export async function sendAudioAndStop(chatContext: ChatContext, lastMessage: ChatMessage, res: Response) {
    const audioUrl = await getAudio(lastMessage);
    if (audioUrl) {
        await sendMessages([
            {
                ...lastMessage,
                hasAudio: true
            }
        ], chatContext, res, true);
    }

    res.end();
}

export async function getChatIdsEndpoint(req: Request, res: Response) {
    const chatIds = await ChatStorage.getChatIds();
    res.send(chatIds);
}

export function getChatEndpoint(req: Request, res: Response) {
    const chatId = req.params.chatId;
    if (!chatId) {
        res.status(400).send('Missing chatId parameter');
        return;
    }

    ChatStorage.readChatContext(chatId).then(chatContext => {
        if (!chatContext) {
            res.status(404).send('Chat not found');
            return;
        }
        res.send(chatContext);
    });
}

export function deleteChatEndpoint(req: Request, res: Response) {
    const chatId = req.params.chatId;
    if (!chatId) {
        res.status(400).send('Missing chatId parameter');
        return;
    }

    ChatStorage.deleteChatContext(chatId).then(() => {
        res.status(200).send('Chat deleted');
    });
}

let models = {};
export async function getModelsEndpoint(req: Request, res: Response) {
    if (Object.keys(models).length === 0) {
        models = await initializeLlms();
    }
    res.status(200).send(models);
}

export function addChatEndpoints(app: Application) {
    app.post('/chat', chatEndpoint);
    app.get('/chat/:chatId', getChatEndpoint);
    app.get('/chats', getChatIdsEndpoint);
    app.delete('/chat/:chatId', deleteChatEndpoint);
    app.get('/models', getModelsEndpoint);
}