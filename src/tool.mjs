/**
 * The MCP tool registrar shared by src/index.mjs and the tests.
 *
 * Every read tool is registered through this one helper so they all behave
 * identically:
 *
 *   - the handler result is serialised as JSON text,
 *   - the result is redacted (via `sanitize`) before it leaves the process,
 *   - a thrown error becomes a visible MCP error (`isError: true`) carrying
 *     the message, never an empty successful result.
 *
 * Keeping the wrapper in one place means a tool cannot accidentally skip
 * redaction or swallow a failure.
 *
 * `tool.names` lists the tools registered through this registrar, in
 * registration order, so the server can report its own tool surface
 * honestly.
 */
export function createToolRegistrar(server, sanitize) {
  const names = [];

  function tool(name, description, schema, handler) {
    names.push(name);
    server.registerTool(
      name,
      {
        description,
        inputSchema: schema,
        annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
      },
      async (args) => {
        try {
          const result = await handler(args);
          return { content: [{ type: 'text', text: JSON.stringify(sanitize(result), null, 2) }] };
        } catch (error) {
          // Never serialise an Axios/error object: it can carry request headers.
          return { isError: true, content: [{ type: 'text', text: sanitize(error.message || 'Read failed.') }] };
        }
      },
    );
  }

  tool.names = names;
  return tool;
}
