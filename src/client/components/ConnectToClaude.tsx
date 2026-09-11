import { CopyButton } from './CopyButton';
import { MCP_URL } from '../mcp';

/** The connector path only: everything token-shaped lives in `ApiTokens`. */
export function ConnectToClaude() {
  return (
    <>
      <p className="note">
        Claude signs in through your browser, so there is no key to copy and nothing to paste back. Add it once and it
        can plan, move and complete your workouts from any conversation.
      </p>

      <article className="card">
        <h3>Add the custom connector</h3>
        <p className="note">
          In Claude, open <strong>Settings → Connectors → Add custom connector</strong> and paste this URL. Claude opens
          a sign-in window; approve it and the tools appear.
        </p>
        <div className="row">
          <code>{MCP_URL}</code>
          <CopyButton label="Copy URL" text={MCP_URL} />
        </div>
      </article>
    </>
  );
}
