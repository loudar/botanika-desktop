import {McpConfiguration} from "./McpConfiguration";

const APP_PORT = Number(process.env.PORT || "48678");

export const defaultMcpConfig: McpConfiguration = {
    servers: [
        {
            name: "Google Search",
            url: `http://localhost:${APP_PORT}/mcp/sse/google/search`
        }
    ]
}