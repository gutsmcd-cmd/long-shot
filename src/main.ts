import './style.css';
import { planStitch, stitchToPng } from './stitch';

interface Shot {
  id: string;
  name: string;
  objectUrl: string;
  img: HTMLImageElement;
}

const shots: Shot[] = [];
let overlap = 0;
let busy = false;

const app = document.querySelector<HTMLDivElement>('#app')!;

function uid(): string {
  return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
}

function loadImage(file: File): Promise<Shot> {
  return new Promise((resolve, reject) => {
    if (!file.type.startsWith('image/')) {
      reject(new Error(`Skipped non-image: ${file.name}`));
      return;
    }
    const objectUrl = URL.createObjectURL(file);
    const img = new Image();
    img.onload = () => {
      resolve({
        id: uid(),
        name: file.name || 'screenshot',
        objectUrl,
        img,
      });
    };
    img.onerror = () => {
      URL.revokeObjectURL(objectUrl);
      reject(new Error(`Could not load ${file.name}`));
    };
    img.src = objectUrl;
  });
}

async function addFiles(fileList: FileList | File[]): Promise<void> {
  const files = Array.from(fileList);
  const errors: string[] = [];
  for (const file of files) {
    try {
      const shot = await loadImage(file);
      shots.push(shot);
    } catch (e) {
      errors.push(e instanceof Error ? e.message : String(e));
    }
  }
  render(errors.length ? errors.join(' ') : null);
}

function moveShot(id: string, dir: -1 | 1): void {
  const i = shots.findIndex((s) => s.id === id);
  if (i < 0) return;
  const j = i + dir;
  if (j < 0 || j >= shots.length) return;
  const tmp = shots[i]!;
  shots[i] = shots[j]!;
  shots[j] = tmp;
  render();
}

function removeShot(id: string): void {
  const i = shots.findIndex((s) => s.id === id);
  if (i < 0) return;
  URL.revokeObjectURL(shots[i]!.objectUrl);
  shots.splice(i, 1);
  render();
}

function clearAll(): void {
  for (const s of shots) URL.revokeObjectURL(s.objectUrl);
  shots.length = 0;
  render();
}

function previewSizeLabel(): string {
  if (shots.length < 2) return '';
  const plan = planStitch(
    shots.map((s) => s.img),
    overlap,
  );
  return `${plan.targetWidth} × ${plan.totalHeight} px`;
}

async function saveLongShot(): Promise<void> {
  if (busy || shots.length < 2) return;
  busy = true;
  render(null, 'Stitching…');

  try {
    const blob = await stitchToPng(
      shots.map((s) => s.img),
      overlap,
    );
    const file = new File([blob], 'long-shot.png', { type: 'image/png' });

    let shared = false;
    if (
      typeof navigator.share === 'function' &&
      typeof navigator.canShare === 'function'
    ) {
      try {
        if (navigator.canShare({ files: [file] })) {
          await navigator.share({
            files: [file],
            title: 'Long Shot',
            text: 'Stitched screenshot',
          });
          shared = true;
        }
      } catch (err) {
        // User cancel is fine; fall through to download
        if (err instanceof DOMException && err.name === 'AbortError') {
          shared = true;
        }
      }
    }

    if (!shared) {
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = 'long-shot.png';
      a.rel = 'noopener';
      document.body.appendChild(a);
      a.click();
      a.remove();
      setTimeout(() => URL.revokeObjectURL(url), 2000);
    }

    busy = false;
    render(null, shared ? 'Shared.' : 'Downloaded long-shot.png');
  } catch (e) {
    busy = false;
    render(e instanceof Error ? e.message : String(e));
  }
}

function render(error: string | null = null, status: string | null = null): void {
  const canSave = shots.length >= 2 && !busy;
  const sizeHint = previewSizeLabel();

  app.innerHTML = `
    <header>
      <h1>Long Shot</h1>
      <p>Stitch screenshots into one tall PNG</p>
    </header>

    <div class="dropzone" id="dropzone" role="button" tabindex="0" aria-label="Add screenshots">
      <p class="hint">Tap or drop images here</p>
      <button type="button" class="btn btn-secondary" id="pick-btn">Add screenshots</button>
      <input type="file" id="file-input" class="sr-only" accept="image/*" multiple />
    </div>

    <div class="controls">
      <label>
        <span class="row">
          <span>Overlap crop</span>
          <span class="value" id="overlap-val">${overlap}px</span>
        </span>
        <input type="range" id="overlap" min="0" max="80" step="1" value="${overlap}" ${shots.length < 2 ? 'disabled' : ''} />
      </label>
      ${sizeHint ? `<div class="status">Preview size: ${sizeHint}</div>` : ''}
    </div>

    ${error ? `<div class="error" role="alert">${escapeHtml(error)}</div>` : ''}

    ${
      shots.length === 0
        ? `<div class="empty">Add screenshots in order — top of page first.</div>`
        : `<ul class="list" id="list">
        ${shots
          .map(
            (s, index) => `
          <li class="shot" data-id="${s.id}">
            <img class="shot-thumb" src="${s.objectUrl}" alt="" />
            <div class="shot-meta">
              <div class="name">${escapeHtml(s.name)}</div>
              <div class="dims">#${index + 1} · ${s.img.naturalWidth}×${s.img.naturalHeight}</div>
            </div>
            <div class="shot-actions">
              <button type="button" class="btn btn-icon" data-act="up" data-id="${s.id}" aria-label="Move up" ${index === 0 ? 'disabled' : ''}>↑</button>
              <button type="button" class="btn btn-icon" data-act="down" data-id="${s.id}" aria-label="Move down" ${index === shots.length - 1 ? 'disabled' : ''}>↓</button>
              <button type="button" class="btn btn-icon danger" data-act="del" data-id="${s.id}" aria-label="Delete">✕</button>
            </div>
          </li>`,
          )
          .join('')}
      </ul>`
    }

    <div class="actions">
      <button type="button" class="btn btn-accent" id="save-btn" ${canSave ? '' : 'disabled'}>
        Save long shot
      </button>
      ${
        shots.length
          ? `<button type="button" class="btn btn-secondary" id="clear-btn" ${busy ? 'disabled' : ''}>Clear all</button>`
          : ''
      }
      <div class="status" id="status">${status ? escapeHtml(status) : ''}</div>
    </div>
  `;

  wire();
}

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function wire(): void {
  const dropzone = document.getElementById('dropzone')!;
  const fileInput = document.getElementById('file-input') as HTMLInputElement;
  const pickBtn = document.getElementById('pick-btn')!;
  const overlapInput = document.getElementById('overlap') as HTMLInputElement;
  const saveBtn = document.getElementById('save-btn');
  const clearBtn = document.getElementById('clear-btn');

  const openPicker = (e?: Event) => {
    e?.stopPropagation();
    fileInput.click();
  };

  pickBtn.addEventListener('click', openPicker);
  dropzone.addEventListener('click', (e) => {
    if ((e.target as HTMLElement).closest('button')) return;
    openPicker();
  });
  dropzone.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' || e.key === ' ') {
      e.preventDefault();
      openPicker();
    }
  });

  fileInput.addEventListener('change', () => {
    if (fileInput.files?.length) {
      void addFiles(fileInput.files);
      fileInput.value = '';
    }
  });

  dropzone.addEventListener('dragenter', (e) => {
    e.preventDefault();
    dropzone.classList.add('dragover');
  });
  dropzone.addEventListener('dragover', (e) => {
    e.preventDefault();
    dropzone.classList.add('dragover');
  });
  dropzone.addEventListener('dragleave', () => {
    dropzone.classList.remove('dragover');
  });
  dropzone.addEventListener('drop', (e) => {
    e.preventDefault();
    dropzone.classList.remove('dragover');
    const dt = e.dataTransfer;
    if (dt?.files?.length) void addFiles(dt.files);
  });

  overlapInput.addEventListener('input', () => {
    overlap = Number(overlapInput.value);
    const val = document.getElementById('overlap-val');
    if (val) val.textContent = `${overlap}px`;
    const status = document.getElementById('status');
    const hint = previewSizeLabel();
    // Update preview size line inside controls without full re-render
    const controls = overlapInput.closest('.controls');
    if (controls) {
      let sizeEl = controls.querySelector('.status');
      if (hint) {
        if (!sizeEl) {
          sizeEl = document.createElement('div');
          sizeEl.className = 'status';
          controls.appendChild(sizeEl);
        }
        sizeEl.textContent = `Preview size: ${hint}`;
      } else if (sizeEl) {
        sizeEl.remove();
      }
    }
    if (status && !busy) status.textContent = '';
  });

  document.querySelectorAll<HTMLButtonElement>('[data-act]').forEach((btn) => {
    btn.addEventListener('click', () => {
      const id = btn.dataset.id!;
      const act = btn.dataset.act;
      if (act === 'up') moveShot(id, -1);
      else if (act === 'down') moveShot(id, 1);
      else if (act === 'del') removeShot(id);
    });
  });

  saveBtn?.addEventListener('click', () => void saveLongShot());
  clearBtn?.addEventListener('click', clearAll);
}

render();
