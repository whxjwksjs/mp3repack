const drop = document.getElementById('drop');
const fileInput = document.getElementById('fileInput');
const results = document.getElementById('results');
const preserveId3Checkbox = document.getElementById('preserveId3');

let worker = null;
let pendingFiles = [];

function getWorker() {
  if (!worker) {
    worker = new Worker('worker.js', { type: 'module' });
    worker.onmessage = handleWorkerMessage;
    worker.onerror = (e) => {
      console.error('Worker error:', e);
      addError('Worker failed to start. Try a different browser.');
    };
  }
  return worker;
}

function handleWorkerMessage(e) {
  const { id, ok, result, error } = e.data;
  const card = document.getElementById(`card-${id}`);
  if (!card) return;

  if (!ok) {
    card.querySelector('.progress').innerHTML = `<span class="error">Error: ${escapeHtml(error)}</span>`;
    return;
  }

  const { outputBytes, inputBytes, savedBytes, passthrough, reason } = result;
  const pct = inputBytes > 0 ? (savedBytes / inputBytes * 100).toFixed(2) : '0.00';

  const blob = new Blob([result.output], { type: 'audio/mpeg' });
  const url = URL.createObjectURL(blob);
  const origName = card.dataset.filename;
  const newName = origName.replace(/\.mp3$/i, '') + '.repacked.mp3';

  let statsHtml;
  if (passthrough) {
    statsHtml = `<div class="stat">No savings possible — <span class="error">${escapeHtml(reason || 'already optimal')}</span></div>`;
  } else {
    statsHtml = `
      <div class="stat">Original: <b>${formatBytes(inputBytes)}</b></div>
      <div class="stat">Repacked: <b>${formatBytes(outputBytes)}</b></div>
      <div class="stat saved">Saved: <b>${formatBytes(savedBytes)} (${pct}%)</b></div>
    `;
  }

  card.querySelector('.progress').innerHTML = `
    <div class="stats">${statsHtml}</div>
    ${!passthrough ? `<a class="download-btn" href="${url}" download="${escapeHtml(newName)}">⬇ Download repacked MP3</a>` : ''}
  `;
}

function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
}

function formatBytes(b) {
  if (b < 1024) return b + ' B';
  if (b < 1024*1024) return (b/1024).toFixed(1) + ' KB';
  return (b/1024/1024).toFixed(2) + ' MB';
}

let nextId = 0;

function processFiles(files) {
  results.classList.add('show');
  const w = getWorker();

  for (const file of files) {
    if (!file.name.toLowerCase().endsWith('.mp3') && file.type !== 'audio/mpeg') {
      continue;
    }
    const id = nextId++;
    const card = document.createElement('div');
    card.className = 'file-card';
    card.id = `card-${id}`;
    card.dataset.filename = file.name;
    card.innerHTML = `
      <div class="file-name">${escapeHtml(file.name)}</div>
      <div class="progress">Repacking…</div>
    `;
    results.prepend(card);

    file.arrayBuffer().then(buf => {
      w.postMessage({ id, buffer: buf, preserveId3: preserveId3Checkbox.checked }, [buf]);
    }).catch(err => {
      card.querySelector('.progress').innerHTML = `<span class="error">Could not read file</span>`;
    });
  }
}

drop.addEventListener('click', () => fileInput.click());
fileInput.addEventListener('change', (e) => {
  processFiles(e.target.files);
  fileInput.value = '';
});

['dragenter', 'dragover'].forEach(ev => {
  drop.addEventListener(ev, (e) => {
    e.preventDefault();
    drop.classList.add('dragover');
  });
});
['dragleave', 'drop'].forEach(ev => {
  drop.addEventListener(ev, (e) => {
    e.preventDefault();
    drop.classList.remove('dragover');
  });
});
drop.addEventListener('drop', (e) => {
  processFiles(e.dataTransfer.files);
});

function addError(msg) {
  const div = document.createElement('div');
  div.className = 'file-card';
  div.innerHTML = `<span class="error">${escapeHtml(msg)}</span>`;
  results.prepend(div);
  results.classList.add('show');
}
