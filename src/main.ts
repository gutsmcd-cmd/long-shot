import './style.css';
import './meter.css';
import {
  planStitch,
  splitParts,
  shotsPerImage,
  stitchToPngs,
  TYPICAL_SHOT,
  WARN_FRACTION,
} from './stitch';

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

const fmt = (n: number): string => n.toLocaleString('en-US');

/** Live height meter + limit warning + "how many fit" hint. */
function meterHtml(): string {
  const plan = planStitch(
    shots.map((s) => s.img),
    overlap,
  );

  // Hint: based on the median added screenshot, or a typical 1080×2400 phone shot.
  let refW = TYPICAL_SHOT.width;
  let refH = TYPICAL_SHOT.height;
  if (shots.length) {
    const sorted = [...shots].sort(
      (a, b) =>
        a.img.naturalHeight / a.img.naturalWidth -
        b.img.naturalHeight / b.img.naturalWidth,
    );
    const mid = sorted[Math.floor(sorted.length / 2)]!.img;
    refW = mid.naturalWidth;
    refH = mid.naturalHeight;
  }
  const fit = shotsPerImage(refW, refH, overlap, plan.targetWidth || refW);
  const hint =
    fit.perImage > 0
      ? `About ${fit.perImage} screenshots of ${refW}×${refH} fit in one image${shots.length ? '' : ' (typical phone size)'}.`
      : `A ${refW}×${refH} screenshot is taller than one image can be — it will be split.`;

  if (shots.length === 0) {
    return `<div class="meter-hint">${hint}</div>`;
  }

  const limit = plan.maxHeight;
  const total = plan.totalHeight;
  const ratio = total / limit;
  const pct = Math.min(100, Math.round(ratio * 100));
  const level = ratio > 1 ? 'over' : ratio >= WARN_FRACTION ? 'warn' : 'ok';
  let note = '';
  if (level === 'over') {
    const parts = splitParts(plan);
    const mid = parts.some((p) => p.cutMidShot);
    note = `Over the ${fmt(limit)} px limit — Long Shot will save ${parts.length} images (part 1–${parts.length}), split ${mid ? 'at screenshot edges where possible' : 'at screenshot edges'}.`;
  } else if (level === 'warn') {
    note = `Close to the ${fmt(limit)} px limit. Add more and it will be saved as several images.`;
  }

  return `
    <div class="meter meter-${level}">
      <div class="row">
        <span>Output height</span>
        <span class="value">${fmt(total)} / ${fmt(limit)} px</span>
      </div>
      <div class="meter-bar" role="meter" aria-label="Output height" aria-valuemin="0" aria-valuemax="${limit}" aria-valuenow="${Math.min(total, limit)}">
        <span style="width:${pct}%"></span>
      </div>
      <div class="meter-sub">${fmt(plan.targetWidth)} px wide${shots.length < 2 ? ' · add at least 2 screenshots' : ''}</div>
      ${note ? `<div class="meter-note" role="status">${note}</div>` : ''}
    </div>
    <div class="meter-hint">${hint}</div>`;
}

function updateMeter(): void {
  const el = document.getElementById('meter');
  if (el) el.innerHTML = meterHtml();
}

function downloadBlob(blob: Blob, name: string): void {
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = name;
  a.rel = 'noopener';
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 4000);
}

async function saveLongShot(): Promise<void> {
  if (busy || shots.length < 2) return;
  busy = true;
  const plannedParts = splitParts(
    planStitch(
      shots.map((s) => s.img),
      overlap,
    ),
  ).length;
  render(
    null,
    plannedParts > 1
      ? `Too tall for one image — splitting into ${plannedParts} parts…`
      : 'Stitching…',
  );

  try {
    const result = await stitchToPngs(
      shots.map((s) => s.img),
      overlap,
      (done, total) => {
        const st = document.getElementById('status');
        if (st && total > 1 && done < total) {
          st.textContent = `Too tall for one image — making part ${done + 1} of ${total}…`;
        }
      },
    );
    const n = result.blobs.length;
    const names =
      n === 1
        ? ['long-shot.png']
        : result.blobs.map((_, i) => `long-shot-part-${i + 1}-of-${n}.png`);
    const files = result.blobs.map(
      (b, i) => new File([b], names[i]!, { type: 'image/png' }),
    );

    let shared = false;
    if (
      typeof navigator.share === 'function' &&
      typeof navigator.canShare === 'function'
    ) {
      try {
        if (navigator.canShare({ files })) {
          await navigator.share({
            files,
            title: 'Long Shot',
            text: n === 1 ? 'Stitched screenshot' : `Stitched screenshot (${n} parts)`,
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
      for (let i = 0; i < n; i++) {
        downloadBlob(result.blobs[i]!, names[i]!);
        if (i < n - 1) await new Promise((r) => setTimeout(r, 350));
      }
    }

    busy = false;
    const splitNote =
      n > 1
        ? ` It was taller than the ${fmt(result.maxHeight)} px limit, so it was split into ${n} images (part 1–${n}).`
        : '';
    render(
      null,
      (shared
        ? n > 1
          ? `Shared ${n} images.`
          : 'Shared.'
        : n > 1
          ? `Downloaded ${names.join(', ')}.`
          : 'Downloaded long-shot.png') + splitNote,
    );
  } catch (e) {
    busy = false;
    render(e instanceof Error ? e.message : String(e));
  }
}

function render(error: string | null = null, status: string | null = null): void {
  const canSave = shots.length >= 2 && !busy;

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
      <div id="meter">${meterHtml()}</div>
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
    updateMeter();
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
