import { useEffect, useState } from 'react';
import {
  createToken,
  listConnections,
  listTokens,
  revokeConnection,
  revokeToken,
  type ApiToken,
  type Connection,
  type IssuedToken,
} from '../api';

const MCP_URL = `${location.origin}/mcp`;

const CONFIG_SNIPPET = JSON.stringify(
  { mcpServers: { workouts: { type: 'http', url: MCP_URL, headers: { Authorization: 'Bearer wk_...' } } } },
  null,
  2,
);

/** Copying can fail outside a secure context, so say so rather than doing nothing. */
function CopyButton({ label, text }: { label: string; text: string }) {
  const [state, setState] = useState<string | null>(null);

  const copy = async () => {
    const ok = await navigator.clipboard.writeText(text).then(
      () => true,
      () => false,
    );
    setState(ok ? 'Copied' : 'Copy failed');
    setTimeout(() => setState(null), 1500);
  };

  return (
    <button className="link" onClick={copy}>
      {state ?? label}
    </button>
  );
}

function Tokens({ tokens, onChanged }: { tokens: ApiToken[]; onChanged: () => void }) {
  const [name, setName] = useState('');
  const [issued, setIssued] = useState<IssuedToken | null>(null);
  const [error, setError] = useState<string | null>(null);

  const create = async (event: React.FormEvent) => {
    event.preventDefault();
    setError(null);
    try {
      setIssued(await createToken(name || 'API token'));
      setName('');
      onChanged();
    } catch (failure) {
      setError((failure as Error).message);
    }
  };

  const revoke = async (token: ApiToken) => {
    if (!confirm(`Revoke ${token.name ?? 'this token'}? Anything using it stops working.`)) return;
    setError(null);
    try {
      await revokeToken(token.prefix);
      onChanged();
    } catch (failure) {
      setError((failure as Error).message);
    }
  };

  return (
    <>
      <h3>Tokens</h3>
      <div className="row">
        <form onSubmit={create}>
          <input placeholder="What is it for? e.g. Garmin watch" value={name} onChange={(e) => setName(e.target.value)} />
          <button className="primary" type="submit">
            New token
          </button>
        </form>
      </div>

      {/* Shown once, right here, because this is the only time the value exists. */}
      {issued && (
        <>
          <div className="secret">{issued.token}</div>
          <p className="note">{issued.note}</p>
        </>
      )}
      {error && <p className="error">{error}</p>}

      {tokens.length === 0 && <p className="note">No tokens yet.</p>}
      {tokens.map((token) => (
        <article className="card" key={token.prefix}>
          <header>
            <h3>{token.name ?? 'API token'}</h3>
            <span className="id">{token.prefix}…</span>
          </header>
          <div className="actions">
            <button className="link danger" onClick={() => void revoke(token)}>
              Revoke
            </button>
          </div>
        </article>
      ))}
    </>
  );
}

function Connections({ connections, onChanged }: { connections: Connection[]; onChanged: () => void }) {
  const [error, setError] = useState<string | null>(null);

  const disconnect = async (connection: Connection) => {
    if (!confirm(`Disconnect ${connection.client_name}? It will have to sign in again.`)) return;
    setError(null);
    try {
      await revokeConnection(connection.id);
      onChanged();
    } catch (failure) {
      setError((failure as Error).message);
    }
  };

  return (
    <>
      <h3>Connected apps</h3>
      {error && <p className="error">{error}</p>}
      {connections.length === 0 && <p className="note">No apps connected yet.</p>}
      {connections.map((connection) => (
        <article className="card" key={connection.id}>
          <header>
            <h3>{connection.client_name}</h3>
            <span className="id">{new Date(connection.created_at).toLocaleDateString()}</span>
          </header>
          <div className="actions">
            <button className="link danger" onClick={() => void disconnect(connection)}>
              Disconnect
            </button>
          </div>
        </article>
      ))}
    </>
  );
}

export function ConnectToClaude() {
  const [tokens, setTokens] = useState<ApiToken[]>([]);
  const [connections, setConnections] = useState<Connection[]>([]);

  const reload = () => {
    void listTokens().then(({ tokens: found }) => setTokens(found));
    void listConnections().then(({ connections: found }) => setConnections(found));
  };

  useEffect(reload, []);

  return (
    <section>
      <h2>Connect to Claude</h2>
      <p className="note">Two ways in, depending on what the client supports.</p>

      <article className="card">
        <h3>Custom connector (recommended)</h3>
        <p className="note">
          In Claude, go to Settings → Connectors → Add custom connector and paste this URL. Claude opens a browser
          window to sign in; there is nothing to paste back.
        </p>
        <div className="row">
          <code>{MCP_URL}</code>
          <CopyButton label="Copy URL" text={MCP_URL} />
        </div>
      </article>

      <article className="card">
        <h3>Static token</h3>
        <p className="note">
          For a client that can only send a fixed header. Create a token below, then drop it into the client's config.
        </p>
        <pre className="snippet">{CONFIG_SNIPPET}</pre>
        <div className="actions">
          <CopyButton label="Copy config" text={CONFIG_SNIPPET} />
        </div>
      </article>

      <Tokens tokens={tokens} onChanged={reload} />
      <Connections connections={connections} onChanged={reload} />
    </section>
  );
}
