import { useEffect, useState } from 'react';
import { listProviders } from '../api';

const LABELS: Record<string, string> = { google: 'Continue with Google', apple: 'Continue with Apple' };

/** A full-page navigation, so there is no success callback to wire up. */
export function SignIn({ intro, returnTo }: { intro: string; returnTo?: string }) {
  const [providers, setProviders] = useState<string[] | null>(null);
  const [error, setError] = useState(() => new URLSearchParams(location.search).get('error'));

  useEffect(() => {
    listProviders().then(
      ({ providers: found }) => setProviders(found ?? []),
      (failure: Error) => {
        setProviders([]);
        setError(failure.message);
      },
    );
  }, []);

  if (providers === null) return null;

  if (providers.length === 0) {
    return (
      <p className="error">
        No sign-in provider is configured. Set <code>GOOGLE_CLIENT_ID</code> and <code>GOOGLE_CLIENT_SECRET</code> on
        the Worker.
      </p>
    );
  }

  return (
    <>
      <p className="sub">{intro}</p>
      <div className="providers">
        {providers.map((provider) => (
          <a
            key={provider}
            className="button"
            href={`/auth/${provider}/start${returnTo ? `?return_to=${encodeURIComponent(returnTo)}` : ''}`}
          >
            {LABELS[provider] ?? `Continue with ${provider}`}
          </a>
        ))}
      </div>
      {error && <p className="error">{error}</p>}
    </>
  );
}
