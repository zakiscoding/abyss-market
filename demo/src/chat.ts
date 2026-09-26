const root = document.getElementById('chat')!;
const log = root.querySelector<HTMLDivElement>('.log')!;
const form = root.querySelector<HTMLFormElement>('form')!;
const input = root.querySelector<HTMLInputElement>('input')!;
const button = root.querySelector<HTMLButtonElement>('button')!;

export function chatPost(who: 'YOU' | 'SHIP' | 'NOTE', text: string) {
  const row = document.createElement('div');
  row.className = `msg ${who.toLowerCase()}`;
  row.innerHTML = `<b></b><span></span>`;
  row.querySelector('b')!.textContent = who;
  row.querySelector('span')!.textContent = text;
  log.appendChild(row);
  log.scrollTop = log.scrollHeight;
}

export function chatClear() {
  log.innerHTML = '';
}

export function askForTask(placeholder: string): Promise<string> {
  input.disabled = false;
  button.disabled = false;
  input.value = placeholder;
  input.focus();
  input.select();
  return new Promise((resolve) => {
    form.onsubmit = (e) => {
      e.preventDefault();
      const text = input.value.trim();
      if (!text) return;
      input.value = '';
      input.disabled = true;
      button.disabled = true;
      form.onsubmit = null;
      resolve(text);
    };
  });
}
