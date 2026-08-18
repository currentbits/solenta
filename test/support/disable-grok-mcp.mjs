// Inline `VAR=1 cmd` is POSIX-only. --import runs on win32 too.
// Renderer tests must not rewrite the user's ~/.grok/mcp.json.
process.env.CODER_GROK_MCP_DISABLE = "1";
