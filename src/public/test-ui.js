const messagesEl = document.getElementById('messages');
const inputEl = document.getElementById('input');
const sendBtn = document.getElementById('sendBtn');
const typingEl = document.getElementById('typing');
const clockEl = document.getElementById('clock');

const SESSION_PHONE = '+1555' + String(Math.floor(Math.random() * 9000000 + 1000000));

function updateClock() {
  const now = new Date();
  clockEl.textContent = now.toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit' });
}
updateClock();
setInterval(updateClock, 10000);

function linkify(text) {
  // Escape HTML first to prevent XSS, then linkify URLs
  const escaped = text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  return escaped.replace(/https?:\/\/[^\s)]+/g, url => `<a href="${url}" target="_blank" style="color:#5ac8fa;text-decoration:underline">${url}</a>`);
}

function addMessage(text, type, meta) {
  const div = document.createElement('div');
  div.className = 'msg ' + type;
  div.innerHTML = linkify(text);
  if (meta) {
    const metaEl = document.createElement('div');
    metaEl.className = 'meta';
    metaEl.textContent = meta;
    div.appendChild(metaEl);
  }
  messagesEl.appendChild(div);
  messagesEl.scrollTop = messagesEl.scrollHeight;
}

function autoResize() {
  inputEl.style.height = 'auto';
  inputEl.style.height = Math.min(inputEl.scrollHeight, 100) + 'px';
}

inputEl.addEventListener('input', () => {
  sendBtn.disabled = !inputEl.value.trim();
  autoResize();
});

inputEl.addEventListener('keydown', (e) => {
  if (e.key === 'Enter' && !e.shiftKey) {
    e.preventDefault();
    if (inputEl.value.trim()) send();
  }
});

sendBtn.addEventListener('click', send);

async function send() {
  const text = inputEl.value.trim();
  if (!text) return;

  inputEl.value = '';
  inputEl.style.height = 'auto';
  sendBtn.disabled = true;

  addMessage(text, 'sent');

  typingEl.classList.add('active');
  messagesEl.scrollTop = messagesEl.scrollHeight;

  const start = Date.now();

  try {
    const res = await fetch('/api/sms/test', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: 'Body=' + encodeURIComponent(text) + '&From=' + encodeURIComponent(SESSION_PHONE),
    });

    const data = await res.json();
    const elapsed = ((Date.now() - start) / 1000).toFixed(1);

    typingEl.classList.remove('active');

    if (data.ok && data.messages?.length > 0) {
      for (const msg of data.messages) {
        addMessage(msg.body, 'received', elapsed + 's');
      }
    } else if (data.error) {
      addMessage('Error: ' + data.error, 'system');
    } else {
      addMessage('(no response)', 'system');
    }
  } catch (err) {
    typingEl.classList.remove('active');
    addMessage('Connection error: ' + err.message, 'system');
  }
}

inputEl.focus();
