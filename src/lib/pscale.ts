// Minimal HTTP client for the bsp-mcp Streamable HTTP transport.
//
// The transport is JSON-RPC 2.0 over POST. The server requires an `initialize`
// handshake and returns a session id in the `Mcp-Session-Id` response header
// which must be echoed on every subsequent request. After `initialize` we
// send a `notifications/initialized` notification, then call tools.
//
// Tool results come back as { content: [{ type: 'text', text: '...' }] }.
// We surface the concatenated text — callers parse the relevant fields.
//
// One client per process; no caching of tool results (the substrate is the
// truth, see CLAUDE.md "no caching beyond a single tick window").

const PROTOCOL_VERSION = '2025-06-18';

export type McpClient = {
  callTool(name: string, args: Record<string, unknown>): Promise<string>;
  close(): Promise<void>;
};

export type McpClientOptions = {
  clientName?: string;
  clientVersion?: string;
  fetchImpl?: typeof fetch;
};

class McpError extends Error {
  constructor(message: string, public readonly code?: number) {
    super(message);
    this.name = 'McpError';
  }
}

export async function createMcpClient(url: string, opts: McpClientOptions = {}): Promise<McpClient> {
  const fetchImpl = opts.fetchImpl ?? fetch;
  const clientInfo = {
    name: opts.clientName ?? 'ticketing-agent',
    version: opts.clientVersion ?? '0.1.0',
  };

  let nextId = 1;
  const newId = () => nextId++;

  // initialize
  const initRes = await fetchImpl(url, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Accept: 'application/json, text/event-stream',
    },
    body: JSON.stringify({
      jsonrpc: '2.0',
      id: newId(),
      method: 'initialize',
      params: { protocolVersion: PROTOCOL_VERSION, capabilities: {}, clientInfo },
    }),
  });
  if (!initRes.ok) {
    throw new McpError(`initialize failed: ${initRes.status} ${initRes.statusText}`);
  }
  const sessionId = initRes.headers.get('Mcp-Session-Id') ?? initRes.headers.get('mcp-session-id');
  if (!sessionId) {
    throw new McpError('initialize: server did not return Mcp-Session-Id');
  }
  const initBody = await readJsonOrEvent(initRes);
  if (initBody.error) {
    throw new McpError(`initialize: ${initBody.error.message}`, initBody.error.code);
  }

  // notifications/initialized — required before tool calls
  const notifyRes = await fetchImpl(url, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Accept: 'application/json, text/event-stream',
      'Mcp-Session-Id': sessionId,
    },
    body: JSON.stringify({
      jsonrpc: '2.0',
      method: 'notifications/initialized',
      params: {},
    }),
  });
  // Notifications return 202 Accepted with no body.
  if (!notifyRes.ok && notifyRes.status !== 202) {
    throw new McpError(`notifications/initialized failed: ${notifyRes.status} ${notifyRes.statusText}`);
  }

  return {
    async callTool(name, args) {
      const res = await fetchImpl(url, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Accept: 'application/json, text/event-stream',
          'Mcp-Session-Id': sessionId,
        },
        body: JSON.stringify({
          jsonrpc: '2.0',
          id: newId(),
          method: 'tools/call',
          params: { name, arguments: args },
        }),
      });
      if (!res.ok) {
        throw new McpError(`tools/call ${name} failed: ${res.status} ${res.statusText}`);
      }
      const body = await readJsonOrEvent(res);
      if (body.error) {
        throw new McpError(`tools/call ${name}: ${body.error.message}`, body.error.code);
      }
      const content = body.result?.content;
      if (!Array.isArray(content)) {
        throw new McpError(`tools/call ${name}: unexpected result shape`);
      }
      // Concatenate all text blocks. Non-text blocks are ignored — current bsp-mcp returns only text.
      return content
        .filter((c: { type?: string }) => c.type === 'text')
        .map((c: { text?: string }) => c.text ?? '')
        .join('\n');
    },
    async close() {
      // The server times sessions out on its own. Sending DELETE is optional;
      // we no-op to keep the surface tiny. Bsp-mcp doesn't require explicit close.
    },
  };
}

// SSE responses come as `data: {json}\n\n`. The bsp-mcp server uses plain JSON
// for tools/call by default but advertises SSE acceptance, so handle both.
async function readJsonOrEvent(res: Response): Promise<{ result?: any; error?: { code: number; message: string } }> {
  const ct = res.headers.get('Content-Type') ?? '';
  if (ct.startsWith('text/event-stream')) {
    const text = await res.text();
    // Pull the first `data:` line that parses as JSON.
    for (const line of text.split('\n')) {
      const t = line.trim();
      if (!t.startsWith('data:')) continue;
      const payload = t.slice(5).trim();
      if (!payload) continue;
      try {
        return JSON.parse(payload);
      } catch {
        // ignore and keep looking
      }
    }
    throw new McpError('SSE response contained no parseable data frame');
  }
  return (await res.json()) as { result?: any; error?: { code: number; message: string } };
}

export { McpError };
