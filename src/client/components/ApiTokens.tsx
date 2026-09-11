import { useEffect, useState } from 'react';
import { createToken, listTokens, revokeToken, type ApiToken, type IssuedToken } from '../api';
import { CopyButton } from './CopyButton';
import { CONFIG_SNIPPET } from '../mcp';

/** A `wk_` token is the way in for any MCP host that cannot do the OAuth dance itself. */
export function ApiTokens() {
  const [tokens, setTokens] = useState<ApiToken[]>([]);
  const [name, setName] = useState('');
  const [issued, setIssued] = useState<IssuedToken | null>(null);
  const [error, setError] = useState<string | null>(null);

  const reload = () => void listTokens().then(({ tokens: found }) => setTokens(found));

  useEffect(reload, []);

  const create = async (event: React.FormEvent) => {
    event.preventDefault();
    setError(null);
    try {
      setIssued(await createToken(name || 'API token'));
      setName('');
      reload();
    } catch (failure) {
      setError((failure as Error).message);
    }
  };

  const revoke = async (token: ApiToken) => {
    if (!confirm(`Revoke ${token.name ?? 'this token'}? Anything using it stops working.`)) return;
    setError(null);
    try {
      await revokeToken(token.prefix);
      reload();
    } catch (failure) {
      setError((failure as Error).message);
    }
  };

  return (
    <>
      <p className="note">
        For any MCP host that only sends a fixed header — Claude Code, Cursor, VS Code, Zed, an agent of your own —
        issue a token here and drop it into that client's server config. The same token works against the plain REST
        API.
      </p>

      <article className="card">
        <h3>Client config</h3>
        <p className="note">
          Most clients take a block like this in their MCP config file. Swap <code>wk_…</code> for the token you issue
          below.
        </p>
        <pre className="snippet">{CONFIG_SNIPPET}</pre>
        <div className="actions">
          <CopyButton label="Copy config" text={CONFIG_SNIPPET} />
        </div>
      </article>

      <div className="row">
        <form onSubmit={create}>
          <input
            placeholder="What is it for? e.g. Garmin watch"
            value={name}
            onChange={(event) => setName(event.target.value)}
          />
          <button className="primary" type="submit">
            New token
          </button>
        </form>
      </div>

      {/* Shown here because this is the only time the full value exists. */}
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
