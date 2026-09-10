/**
 * The sign-in panel, shared by the dashboard and the OAuth consent page.
 *
 * There is no form to fill in: the server says which providers it has
 * configured, and each button is a plain link into that provider's flow. The
 * session cookie set on the way back is what carries the login onwards.
 */

export const el = (tag, props = {}, children = []) => {
  const node = Object.assign(document.createElement(tag), props);
  for (const child of children) node.append(child);
  return node;
};

export async function api(path, options = {}) {
  const response = await fetch(path, {
    ...options,
    headers: { 'Content-Type': 'application/json', ...options.headers },
    body: options.body === undefined ? undefined : JSON.stringify(options.body),
  });
  const body = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(body.error ?? `request failed (${response.status})`);
  return body;
}

/** The signed-in user, or null. */
export async function currentUser() {
  try {
    return await api('/api/me');
  } catch {
    return null;
  }
}

const PROVIDER_LABELS = { google: 'Continue with Google', apple: 'Continue with Apple' };

/**
 * Render the sign-in buttons into `container`.
 *
 * Signing in is a full-page navigation, so there is no callback: the browser
 * leaves and comes back to `returnTo` already authenticated.
 */
export async function mountLogin(container, { intro, returnTo } = {}) {
  const message = el('p', { className: 'note' });

  // A failed sign-in comes back as ?error=... on the dashboard.
  const reported = new URLSearchParams(location.search).get('error');
  if (reported) {
    message.className = 'error';
    message.textContent = reported;
  }

  let providers = [];
  try {
    ({ providers } = await api('/auth/providers'));
  } catch (error) {
    message.className = 'error';
    message.textContent = error.message;
  }

  if (providers.length === 0) {
    container.replaceChildren(
      el('p', { className: 'error' }, [
        'No sign-in provider is configured. Set ',
        el('code', { textContent: 'GOOGLE_CLIENT_ID' }),
        ' and ',
        el('code', { textContent: 'GOOGLE_CLIENT_SECRET' }),
        ' on the Worker.',
      ]),
      message,
    );
    return;
  }

  const buttons = providers.map((provider) => {
    const href = `/auth/${provider}/start`;
    return el('a', {
      className: 'button provider',
      href: returnTo ? `${href}?return_to=${encodeURIComponent(returnTo)}` : href,
      textContent: PROVIDER_LABELS[provider] ?? `Continue with ${provider}`,
    });
  });

  container.replaceChildren(
    ...(intro ? [el('p', { className: 'sub', textContent: intro })] : []),
    el('div', { className: 'providers' }, buttons),
    message,
  );
}
