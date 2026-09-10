/**
 * The email + one-time-code sign-in form, shared by the dashboard and the
 * OAuth consent page. Both need exactly the same two steps, and the session
 * cookie the server sets is what carries the login onwards.
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

/**
 * Render the sign-in form into `container` and resolve `onSignedIn` with the
 * user once the code is accepted.
 */
export function mountLogin(container, onSignedIn, { intro } = {}) {
  let email = '';

  const message = el('p', { className: 'note' });
  const showError = (text) => {
    message.className = 'error';
    message.textContent = text;
  };
  const showNote = (text) => {
    message.className = 'note';
    message.textContent = text;
  };

  function askForEmail() {
    const input = el('input', { type: 'email', placeholder: 'you@example.com', autocomplete: 'email', required: true });
    const submit = el('button', { className: 'primary', type: 'submit', textContent: 'Email me a code' });

    const form = el('form', {}, [input, submit]);
    form.onsubmit = async (event) => {
      event.preventDefault();
      submit.disabled = true;
      try {
        email = input.value.trim();
        await api('/api/auth/request-code', { method: 'POST', body: { email } });
        askForCode();
      } catch (error) {
        showError(error.message);
        submit.disabled = false;
      }
    };

    container.replaceChildren(
      ...(intro ? [el('p', { className: 'sub', textContent: intro })] : []),
      el('div', { className: 'row' }, [form]),
      message,
    );
    input.focus();
  }

  function askForCode() {
    const input = el('input', {
      className: 'code',
      inputMode: 'numeric',
      autocomplete: 'one-time-code',
      placeholder: '000000',
      maxLength: 6,
      required: true,
    });
    const submit = el('button', { className: 'primary', type: 'submit', textContent: 'Sign in' });

    const form = el('form', {}, [input, submit]);
    form.onsubmit = async (event) => {
      event.preventDefault();
      submit.disabled = true;
      try {
        onSignedIn(await api('/api/auth/verify', { method: 'POST', body: { email, code: input.value } }));
      } catch (error) {
        showError(error.message);
        submit.disabled = false;
        input.select();
      }
    };

    const back = el('button', { className: 'link', type: 'button', textContent: 'Use a different address' });
    back.onclick = askForEmail;

    container.replaceChildren(el('div', { className: 'row' }, [form]), message, back);
    showNote(`We sent a six-digit code to ${email}. It expires in 10 minutes.`);
    input.focus();
  }

  askForEmail();
}
