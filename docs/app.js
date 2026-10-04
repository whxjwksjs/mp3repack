const drop = document.getElementById('drop');
const fileInput = document.getElementById('fileInput');
const results = document.getElementById('results');
const preserveId3Checkbox = document.getElementById('preserveId3');

const w = new Worker('worker.js');
const jobs = new Map();
let jobId = 0;

w.onmessage = (e) => {
  const { id, ok, result, error } = e.data;
  const job = jobs.get(id);
  if (!job) return;
  jobs.delete(id);
  const card = job.card;
  if (!ok) {
    card.querySelector('.status').innerHTML = `<span class="err">Error: ${escapeHtml(error)}</span>`;
    return;
  }
  const r = result;
  const savedPct = r.inputBytes > 0 ? (100 * r.savedBytes / r.inputBytes) : 0;
  const barWidth = r.inputBytes > 0 ? Math.min(100, 100 * r.outputBytes / r.inputBytes) : 100;

  let statusHtml;
  if (r.passthrough) {
    statusHtml = `<span class="status">No savings — ${escapeHtml(r.reason || 'already optimal')}</span>`;
  } else {
    statusHtml = `
      <div class="stats">
        <div class="stat"><div class="label">Original</div><div class="value">${fmtBytes(r.inputBytes)}</div></div>
        <div class="stat"><div class="label">Repacked</div><div class="value">${fmtBytes(r.outputBytes)}</div></div>
        <div class="stat"><div class="label">Saved</div><div class="value saved">${fmtBytes(r.savedBytes)} (${savedPct.toFixed(1)}%)</div></div>
      </div>
      <div class="bar"><div class="fill" style="width:${barWidth.toFixed(1)}%"></div></div>
    `;
  }

  let downloadHtml = '';
  if (!r.passthrough || r.output) {
    const blob = new Blob([r.output], { type: 'audio/mpeg' });
    const url = URL.createObjectURL(blob);
    const outName = job.file.name.replace(/\.mp3$/i, '') + '.repacked.mp3';
    downloadHtml = `<a class="btn primary" href="${url}" download="${escapeHtml(outName)}">Download</a>`;
  }

  card.innerHTML = `
    <div class="name">${escapeHtml(job.file.name)}</div>
    ${statusHtml}
    <div class="actions">${downloadHtml}</div>
  `;
};

function fmtBytes(n) {
  if (n < 1024) return n + ' B';
  if (n < 1048576) return (n / 1024).toFixed(1) + ' KB';
  return (n / 1048576).toFixed(2) + ' MB';
}

function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, c => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'
  }[c]));
}

function processFile(file) {
  const id = ++jobId;
  const card = document.createElement('div');
  card.className = 'card';
  card.innerHTML = `
    <div class="name">${escapeHtml(file.name)}</div>
    <div class="status">Processing…</div>
  `;
  results.prepend(card);
  jobs.set(id, { file, card });
  file.arrayBuffer().then(buf => {
    w.postMessage({ id, buffer: buf, preserveId3: preserveId3Checkbox.checked }, [buf]);
  }).catch(() => {
    card.querySelector('.status').innerHTML = `<span class="err">Could not read file</span>`;
    jobs.delete(id);
  });
}

drop.addEventListener('click', () => fileInput.click());
fileInput.addEventListener('change', () => {
  for (const f of fileInput.files) processFile(f);
  fileInput.value = '';
});
['dragover', 'dragenter'].forEach(ev => drop.addEventListener(ev, e => {
  e.preventDefault();
  drop.classList.add('over');
}));
['dragleave', 'drop'].forEach(ev => drop.addEventListener(ev, e => {
  e.preventDefault();
  drop.classList.remove('over');
}));
drop.addEventListener('drop', e => {
  for (const f of e.dataTransfer.files) {
    if (/\.mp3$/i.test(f.name) || f.type === 'audio/mpeg') processFile(f);
  }
});
