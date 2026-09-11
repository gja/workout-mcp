import { useEffect, useState } from 'react';
import { listConnections, revokeConnection, type Connection } from '../api';

/** The other side of the connector flow: what has signed in, and how to cut it off. */
export function ConnectedApps() {
  const [connections, setConnections] = useState<Connection[]>([]);
  const [error, setError] = useState<string | null>(null);

  const reload = () => void listConnections().then(({ connections: found }) => setConnections(found));

  useEffect(reload, []);

  const disconnect = async (connection: Connection) => {
    if (!confirm(`Disconnect ${connection.client_name}? It will have to sign in again.`)) return;
    setError(null);
    try {
      await revokeConnection(connection.id);
      reload();
    } catch (failure) {
      setError((failure as Error).message);
    }
  };

  return (
    <>
      <p className="note">Apps you approved through the connector flow. Revoking one does not touch your tokens.</p>

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
