const fileInput = document.querySelector("#fileInput");
const dropzone = document.querySelector("#dropzone");
const gallery = document.querySelector("#gallery");
const emptyState = document.querySelector("#emptyState");
const fileCount = document.querySelector("#fileCount");
const doneCount = document.querySelector("#doneCount");
const qualityMode = document.querySelector("#qualityMode");
const strength = document.querySelector("#strength");
const feather = document.querySelector("#feather");
const strengthValue = document.querySelector("#strengthValue");
const featherValue = document.querySelector("#featherValue");
const sampleMode = document.querySelector("#sampleMode");
const transparentPreview = document.querySelector("#transparentPreview");
const processAllBtn = document.querySelector("#processAllBtn");
const downloadZipBtn = document.querySelector("#downloadZipBtn");
const clearBtn = document.querySelector("#clearBtn");
const creditsBtn = document.querySelector("#creditsBtn");
const creditsModal = document.querySelector("#creditsModal");
const closeCredits = document.querySelector("#closeCredits");
const demoBtn = document.querySelector("#demoBtn");

const queue = [];
const waitFrame = () => new Promise((resolve) => requestAnimationFrame(resolve));

const formatBytes = (bytes) => {
  const units = ["B", "KB", "MB", "GB"];
  let size = bytes;
  let index = 0;
  while (size >= 1024 && index < units.length - 1) {
    size /= 1024;
    index += 1;
  }
  return `${size.toFixed(size >= 10 || index === 0 ? 0 : 1)} ${units[index]}`;
};

const safeName = (name) => name.replace(/\.[^.]+$/, "").replace(/[^\w-]+/g, "-").replace(/^-|-$/g, "") || "image";

const updateStats = () => {
  const ready = queue.filter((item) => item.resultUrl).length;
  fileCount.textContent = `${queue.length} ${queue.length === 1 ? "file" : "files"}`;
  doneCount.textContent = `${ready} ready`;
  emptyState.hidden = queue.length > 0;
  processAllBtn.disabled = queue.length === 0;
  clearBtn.disabled = queue.length === 0;
  downloadZipBtn.disabled = ready === 0;
};

const setPreviewMode = () => {
  document.querySelectorAll(".preview-wrap").forEach((wrap) => {
    wrap.classList.toggle("checker", transparentPreview.checked);
  });
};

const setProgress = (item, amount, label = "Working") => {
  const percent = Math.max(0, Math.min(100, Math.round(amount)));
  item.card.querySelector(".status-pill").textContent = `${label} ${percent}%`;
  item.card.querySelector(".progress-bar").style.width = `${percent}%`;
};

const setCardState = (item, state, label) => {
  const pill = item.card.querySelector(".status-pill");
  pill.textContent = label;
  pill.style.background = state === "error" ? "var(--danger)" : state === "ready" ? "var(--aqua)" : "var(--gold)";
};

const createCard = (item) => {
  const card = document.createElement("article");
  card.className = "image-card";
  card.dataset.id = item.id;
  card.innerHTML = `
    <div class="preview-wrap checker">
      <img src="${item.originalUrl}" alt="Preview of ${item.file.name}">
      <span class="status-pill">Queued</span>
      <span class="progress-track" aria-hidden="true"><span class="progress-bar"></span></span>
    </div>
    <div class="card-body">
      <p class="file-name" title="${item.file.name}">${item.file.name}</p>
      <p class="file-meta">${formatBytes(item.file.size)}</p>
      <div class="card-actions">
        <button class="soft-button process-one" type="button">Process</button>
        <button class="soft-button download-one" type="button" disabled>Download</button>
      </div>
    </div>
  `;

  card.querySelector(".process-one").addEventListener("click", () => processItem(item));
  card.querySelector(".download-one").addEventListener("click", () => downloadItem(item));
  gallery.prepend(card);
  item.card = card;
  setPreviewMode();
};

const readImage = (file) => new Promise((resolve, reject) => {
  const img = new Image();
  img.onload = () => resolve(img);
  img.onerror = reject;
  img.src = URL.createObjectURL(file);
});

const pixelIndex = (x, y, width) => (y * width + x) * 4;
const maskIndex = (x, y, width) => y * width + x;

const colorDistance = (r, g, b, sample) => {
  const dr = r - sample[0];
  const dg = g - sample[1];
  const db = b - sample[2];
  return Math.sqrt((dr * dr) + (dg * dg) + (db * db));
};

const getPixel = (data, x, y, width) => {
  const index = pixelIndex(x, y, width);
  return [data[index], data[index + 1], data[index + 2]];
};

const collectEdgeSamples = (data, width, height) => {
  const samples = [];
  const step = Math.max(1, Math.floor(Math.min(width, height) / 26));

  if (sampleMode.value === "white") return [[250, 250, 250], [235, 235, 235], [255, 255, 255]];
  if (sampleMode.value === "green") return [[0, 255, 0], [35, 190, 75], [75, 220, 95]];
  if (sampleMode.value === "blue") return [[0, 0, 255], [40, 120, 255], [75, 150, 245]];
  if (sampleMode.value === "dark") return [[8, 10, 14], [22, 24, 28], [0, 0, 0]];

  for (let x = 0; x < width; x += step) {
    samples.push(getPixel(data, x, 0, width));
    samples.push(getPixel(data, x, height - 1, width));
  }
  for (let y = 0; y < height; y += step) {
    samples.push(getPixel(data, 0, y, width));
    samples.push(getPixel(data, width - 1, y, width));
  }

  return samples;
};

const nearestSampleDistance = (data, x, y, width, samples) => {
  const index = pixelIndex(x, y, width);
  const r = data[index];
  const g = data[index + 1];
  const b = data[index + 2];
  let nearest = Infinity;
  for (const sample of samples) {
    nearest = Math.min(nearest, colorDistance(r, g, b, sample));
  }
  return nearest;
};

const similarNeighbors = (data, current, next) => {
  const dr = data[current] - data[next];
  const dg = data[current + 1] - data[next + 1];
  const db = data[current + 2] - data[next + 2];
  return Math.sqrt((dr * dr) + (dg * dg) + (db * db));
};

const buildBackgroundMask = async (data, width, height, samples, item) => {
  const total = width * height;
  const mask = new Uint8Array(total);
  const visited = new Uint8Array(total);
  const queueX = new Int32Array(total);
  const queueY = new Int32Array(total);
  const baseTolerance = Number(strength.value);
  const quality = qualityMode.value;
  const floodTolerance = quality === "high" ? baseTolerance + 34 : quality === "balanced" ? baseTolerance + 22 : baseTolerance + 12;
  const neighborTolerance = quality === "high" ? 54 : quality === "balanced" ? 42 : 30;
  let head = 0;
  let tail = 0;
  let processed = 0;

  const push = (x, y) => {
    const mi = maskIndex(x, y, width);
    if (visited[mi]) return;
    visited[mi] = 1;
    queueX[tail] = x;
    queueY[tail] = y;
    tail += 1;
  };

  for (let x = 0; x < width; x += 1) {
    push(x, 0);
    push(x, height - 1);
  }
  for (let y = 1; y < height - 1; y += 1) {
    push(0, y);
    push(width - 1, y);
  }

  while (head < tail) {
    const x = queueX[head];
    const y = queueY[head];
    head += 1;
    processed += 1;

    const currentDataIndex = pixelIndex(x, y, width);
    const distance = nearestSampleDistance(data, x, y, width, samples);
    if (distance <= floodTolerance) {
      mask[maskIndex(x, y, width)] = 1;
      const neighbors = [[x + 1, y], [x - 1, y], [x, y + 1], [x, y - 1]];
      for (const [nx, ny] of neighbors) {
        if (nx < 0 || ny < 0 || nx >= width || ny >= height) continue;
        const ni = maskIndex(nx, ny, width);
        if (visited[ni]) continue;
        const nextDataIndex = pixelIndex(nx, ny, width);
        const nextDistance = nearestSampleDistance(data, nx, ny, width, samples);
        const localDistance = similarNeighbors(data, currentDataIndex, nextDataIndex);
        if (nextDistance <= floodTolerance || (nextDistance <= floodTolerance + 32 && localDistance <= neighborTolerance)) {
          push(nx, ny);
        }
      }
    }

    if (processed % 18000 === 0) {
      setProgress(item, 12 + (Math.min(1, processed / total) * 38), "Scanning");
      await waitFrame();
    }
  }

  return mask;
};

const expandMask = (mask, width, height, rounds) => {
  let current = mask;
  for (let round = 0; round < rounds; round += 1) {
    const next = new Uint8Array(current);
    for (let y = 1; y < height - 1; y += 1) {
      for (let x = 1; x < width - 1; x += 1) {
        const i = maskIndex(x, y, width);
        if (current[i]) continue;
        const count = current[i - 1] + current[i + 1] + current[i - width] + current[i + width];
        if (count >= 3) next[i] = 1;
      }
    }
    current = next;
  }
  return current;
};

const smoothAlpha = (mask, width, height, softness) => {
  const alpha = new Uint8ClampedArray(width * height);
  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      const i = maskIndex(x, y, width);
      if (!mask[i]) {
        alpha[i] = 255;
        continue;
      }

      let subjectNearby = 0;
      for (let oy = -softness; oy <= softness; oy += 1) {
        for (let ox = -softness; ox <= softness; ox += 1) {
          const nx = x + ox;
          const ny = y + oy;
          if (nx < 0 || ny < 0 || nx >= width || ny >= height) continue;
          if (!mask[maskIndex(nx, ny, width)]) subjectNearby += 1;
        }
      }
      alpha[i] = subjectNearby > 0 ? Math.min(170, subjectNearby * 9) : 0;
    }
  }
  return alpha;
};

const removeBackground = async (file, item) => {
  const image = await readImage(file);
  const maxByMode = qualityMode.value === "high" ? 2200 : qualityMode.value === "balanced" ? 1700 : 1250;
  const ratio = Math.min(1, maxByMode / Math.max(image.naturalWidth, image.naturalHeight));
  const width = Math.max(1, Math.round(image.naturalWidth * ratio));
  const height = Math.max(1, Math.round(image.naturalHeight * ratio));

  setProgress(item, 6, "Loading");
  await waitFrame();

  const canvas = document.createElement("canvas");
  canvas.width = width;
  canvas.height = height;
  const ctx = canvas.getContext("2d", { willReadFrequently: true });
  ctx.drawImage(image, 0, 0, width, height);

  const imageData = ctx.getImageData(0, 0, width, height);
  const { data } = imageData;
  const samples = collectEdgeSamples(data, width, height);
  setProgress(item, 12, "Sampling");
  await waitFrame();

  let mask = await buildBackgroundMask(data, width, height, samples, item);
  setProgress(item, 58, "Refining");
  await waitFrame();

  const expandRounds = qualityMode.value === "high" ? 2 : qualityMode.value === "balanced" ? 1 : 0;
  mask = expandMask(mask, width, height, expandRounds);
  const softness = Number(feather.value);
  const alpha = smoothAlpha(mask, width, height, softness);
  setProgress(item, 82, "Softening");
  await waitFrame();

  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      const mi = maskIndex(x, y, width);
      const di = pixelIndex(x, y, width);
      data[di + 3] = alpha[mi];
    }
    if (y % 160 === 0) {
      setProgress(item, 82 + ((y / height) * 15), "Applying");
      await waitFrame();
    }
  }

  ctx.putImageData(imageData, 0, 0);
  setProgress(item, 100, "Done");
  return canvas.toDataURL("image/png");
};

const processItem = async (item) => {
  setCardState(item, "working", "Starting");
  item.card.querySelector(".process-one").disabled = true;
  try {
    item.resultUrl = await removeBackground(item.file, item);
    item.card.querySelector("img").src = item.resultUrl;
    item.card.querySelector(".download-one").disabled = false;
    setCardState(item, "ready", "Ready");
  } catch (error) {
    console.error(error);
    setCardState(item, "error", "Failed");
    item.card.querySelector(".process-one").disabled = false;
  }
  updateStats();
};

const dataUrlToBlob = async (dataUrl) => {
  const response = await fetch(dataUrl);
  return response.blob();
};

const downloadBlob = (blob, filename) => {
  const url = URL.createObjectURL(blob);
  const link = document.createElement("a");
  link.href = url;
  link.download = filename;
  document.body.appendChild(link);
  link.click();
  link.remove();
  URL.revokeObjectURL(url);
};

const downloadItem = async (item) => {
  if (!item.resultUrl) return;
  downloadBlob(await dataUrlToBlob(item.resultUrl), `${safeName(item.file.name)}-vanishlab.png`);
};

const processAll = async () => {
  processAllBtn.disabled = true;
  for (const item of queue) {
    if (!item.resultUrl) {
      await processItem(item);
    }
  }
  processAllBtn.disabled = queue.length === 0;
};

const downloadZip = async () => {
  const ready = queue.filter((item) => item.resultUrl);
  if (ready.length === 0) return;

  if (!window.JSZip) {
    for (const item of ready) {
      await downloadItem(item);
    }
    return;
  }

  downloadZipBtn.disabled = true;
  downloadZipBtn.textContent = "Building";
  const zip = new JSZip();
  for (const item of ready) {
    const blob = await dataUrlToBlob(item.resultUrl);
    zip.file(`${safeName(item.file.name)}-vanishlab.png`, blob);
  }
  const zipped = await zip.generateAsync({ type: "blob" });
  downloadBlob(zipped, "vanishlab-results.zip");
  downloadZipBtn.textContent = "Download Zip";
  updateStats();
};

const addFiles = (files) => {
  const images = [...files].filter((file) => file.type.startsWith("image/"));
  images.forEach((file) => {
    const item = {
      id: crypto.randomUUID(),
      file,
      originalUrl: URL.createObjectURL(file),
      resultUrl: "",
      card: null,
    };
    queue.push(item);
    createCard(item);
  });
  updateStats();
};

const clearAll = () => {
  queue.forEach((item) => {
    URL.revokeObjectURL(item.originalUrl);
  });
  queue.length = 0;
  gallery.innerHTML = "";
  updateStats();
};

fileInput.addEventListener("change", (event) => addFiles(event.target.files));

["dragenter", "dragover"].forEach((eventName) => {
  dropzone.addEventListener(eventName, (event) => {
    event.preventDefault();
    dropzone.classList.add("drag-over");
  });
});

["dragleave", "drop"].forEach((eventName) => {
  dropzone.addEventListener(eventName, (event) => {
    event.preventDefault();
    dropzone.classList.remove("drag-over");
  });
});

dropzone.addEventListener("drop", (event) => addFiles(event.dataTransfer.files));
processAllBtn.addEventListener("click", processAll);
downloadZipBtn.addEventListener("click", downloadZip);
clearBtn.addEventListener("click", clearAll);
transparentPreview.addEventListener("change", setPreviewMode);

strength.addEventListener("input", () => {
  strengthValue.textContent = strength.value;
});

feather.addEventListener("input", () => {
  featherValue.textContent = feather.value;
});

creditsBtn.addEventListener("click", () => creditsModal.showModal());
closeCredits.addEventListener("click", () => creditsModal.close());
creditsModal.addEventListener("click", (event) => {
  if (event.target === creditsModal) creditsModal.close();
});

demoBtn.addEventListener("click", () => {
  const canvas = document.createElement("canvas");
  canvas.width = 1000;
  canvas.height = 1000;
  const ctx = canvas.getContext("2d");
  ctx.fillStyle = "#dbe9ff";
  ctx.fillRect(0, 0, canvas.width, canvas.height);
  ctx.fillStyle = "#6aa7ff";
  ctx.fillRect(0, 0, 1000, 230);
  ctx.fillStyle = "#ff6b9d";
  ctx.beginPath();
  ctx.arc(500, 500, 220, 0, Math.PI * 2);
  ctx.fill();
  ctx.fillStyle = "#ffd166";
  ctx.fillRect(350, 680, 300, 140);
  ctx.fillStyle = "#080b12";
  ctx.font = "900 78px Inter, sans-serif";
  ctx.textAlign = "center";
  ctx.fillText("VANISH", 500, 500);
  ctx.fillText("LAB", 500, 600);
  canvas.toBlob((blob) => {
    const file = new File([blob], "vanishlab-demo.png", { type: "image/png" });
    addFiles([file]);
  });
});

updateStats();
