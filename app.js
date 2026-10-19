import { createPdfSearchEntry, createSearchIndex, extractPdfText, normalizeStudyText, rankIndexedSentences, studyTerms, summarizeStudyNotes } from "./study-notes.mjs";

const $ = (selector, root = document) => root.querySelector(selector);
const $$ = (selector, root = document) => [...root.querySelectorAll(selector)];
const reducedMotion = matchMedia("(prefers-reduced-motion: reduce)").matches;

const courseGrid = $("#courseGrid");
const lessonDetail = $("#lessonDetail");
const uploadedList = $("#uploadedList");
const courseSearch = $("#courseSearch");
const uploadStatus = $("#uploadStatus");
const wenCourseSelect = $("#wenCourseSelect");
const uploadCourse = $("#uploadCourse");
let courses = [];
let activeCourse = null;
let activeLesson = 0;
let searchTimer = 0;
let wenBusy = false;
let studyDatabase;
let archiveIndexPromise;
let lessonIndex = [];
const archiveObjectUrls = new Set();

const openStudyDatabase = () => {
  if (studyDatabase) return studyDatabase;
  studyDatabase = new Promise((resolve, reject) => {
    const request = indexedDB.open("manajemen-c-study-archive", 2);
    request.onupgradeneeded = event => {
      const database = request.result;
      const transaction = request.transaction;
      const pdfs = database.objectStoreNames.contains("pdfs")
        ? transaction.objectStore("pdfs")
        : database.createObjectStore("pdfs", { keyPath: "id" });
      const search = database.objectStoreNames.contains("search")
        ? transaction.objectStore("search")
        : database.createObjectStore("search", { keyPath: "id" });
      if (!search.indexNames.contains("courseId")) search.createIndex("courseId", "courseId");
      if (event.oldVersion < 2) {
        const cursorRequest = pdfs.openCursor();
        cursorRequest.onsuccess = () => {
          const cursor = cursorRequest.result;
          if (!cursor) return;
          search.put(createPdfSearchEntry(cursor.value));
          cursor.continue();
        };
      }
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(new Error("Arsip lokal tidak dapat dibuka. Periksa pengaturan penyimpanan browser."));
  });
  return studyDatabase;
};

const withArchiveStore = async (mode, operation, storeName = "pdfs") => {
  const database = await openStudyDatabase();
  return new Promise((resolve, reject) => {
    const transaction = database.transaction(storeName, mode);
    const request = operation(transaction.objectStore(storeName));
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(new Error("Perubahan arsip lokal gagal disimpan."));
    transaction.onabort = () => reject(new Error("Penyimpanan arsip lokal dibatalkan."));
  });
};

const readArchiveItem = id => withArchiveStore("readonly", store => store.get(id));
const withArchiveTransaction = async (stores, operation) => {
  const database = await openStudyDatabase();
  return new Promise((resolve, reject) => {
    const transaction = database.transaction(stores, "readwrite");
    operation(transaction);
    transaction.oncomplete = () => resolve();
    transaction.onerror = () => reject(new Error("Perubahan arsip lokal gagal disimpan."));
    transaction.onabort = () => reject(new Error("Penyimpanan arsip lokal dibatalkan."));
  });
};
const loadArchiveIndex = () => {
  if (!archiveIndexPromise) {
    archiveIndexPromise = withArchiveStore("readonly", store => store.getAll(), "search").then(entries => {
      return entries.map(entry => ({ ...entry, termSet: new Set(entry.terms) }));
    }).catch(error => {
      archiveIndexPromise = null;
      throw error;
    });
  }
  return archiveIndexPromise;
};
const saveArchiveItem = item => withArchiveTransaction(["pdfs", "search"], transaction => {
  transaction.objectStore("pdfs").put(item);
  transaction.objectStore("search").put(createPdfSearchEntry(item));
}).then(() => {
  archiveIndexPromise = null;
});
const deleteArchiveItem = id => withArchiveTransaction(["pdfs", "search"], transaction => {
  transaction.objectStore("pdfs").delete(id);
  transaction.objectStore("search").delete(id);
}).then(() => {
  archiveIndexPromise = null;
});

const setStatus = (element, message, state = "") => {
  element.textContent = message;
  element.dataset.state = state;
};

const addSourceChips = (message, sources, answerText = "") => {
  if (sources?.length) {
    const list = document.createElement("span");
    list.className = "wen-source-list";
    sources.forEach(source => {
      const chip = document.createElement("span");
      chip.className = "source-chip";
      chip.textContent = `${source.type === "pdf" ? "PDF" : "MATERI"} · ${source.course} · ${source.title}`;
      list.append(chip);
    });
    message.append(list);
  }
  const concepts = [...new Set((sources || []).flatMap(source => source.concepts || []))].slice(0, 6);
  if (!concepts.length && answerText) {
    const stopWords = new Set(["yang", "dan", "atau", "dengan", "untuk", "dalam", "pada", "dari", "adalah", "sebagai", "dapat", "akan", "serta", "the", "this", "that", "with", "from"]);
    answerText.match(/[\p{L}\p{N}-]{4,}/gu)?.forEach(word => {
      const normalized = normalize(word);
      if (!stopWords.has(normalized) && !concepts.some(item => normalize(item) === normalized)) concepts.push(word);
    });
  }
  if (!concepts.length) return;
  const visual = createElement("div", "wen-hologram");
  visual.setAttribute("role", "img");
  visual.setAttribute("aria-label", `Hologram konsep: ${concepts.join(", ")}`);
  visual.append(createElement("span", "wen-holo-title", "✧ PETA KONSEP · HOLOGRAM 3D"));
  const scene = createElement("div", "wen-holo-scene");
  const ring = createElement("span", "wen-holo-ring");
  ring.setAttribute("aria-hidden", "true");
  scene.append(ring, createElement("span", "wen-holo-core"));
  concepts.slice(0, 6).forEach((concept, index) => {
    const node = createElement("span", "wen-holo-node", concept);
    const angle = -Math.PI / 2 + index * Math.PI * 2 / Math.min(concepts.length, 6);
    node.style.left = `${50 + Math.cos(angle) * 34}%`;
    node.style.top = `${50 + Math.sin(angle) * 34}%`;
    node.style.setProperty("--wen-depth", `${10 + index % 3 * 9}px`);
    scene.append(node);
  });
  visual.append(scene);
  visual.addEventListener("pointermove", event => {
    const rect = visual.getBoundingClientRect();
    scene.style.setProperty("--wen-tilt-x", `${((event.clientY - rect.top) / rect.height - .5) * -12}deg`);
    scene.style.setProperty("--wen-tilt-y", `${((event.clientX - rect.left) / rect.width - .5) * 16}deg`);
  });
  visual.addEventListener("pointerleave", () => {
    scene.style.setProperty("--wen-tilt-x", "0deg");
    scene.style.setProperty("--wen-tilt-y", "0deg");
  });
  message.append(visual);
};

const appendWenMessage = (text, sender, sources = []) => {
  const message = document.createElement("div");
  message.className = `wen-message${sender === "user" ? " user" : ""}`;
  message.textContent = text;
  if (sender !== "user") addSourceChips(message, sources, text);
  $("#wenMessages").append(message);
  $("#wenMessages").scrollTop = $("#wenMessages").scrollHeight;
  return message;
};

const askWenAI = async (question, courseId = wenCourseSelect.value) => {
  const queryTerms = new Set(studyTerms(question));
  const terms = [...queryTerms];
  const candidates = [];
  const matchesQuery = item => terms.reduce((total, term) => total + Number(item.termSet.has(term)), 0);
  lessonIndex.filter(item => !courseId || item.courseId === courseId).forEach(item => {
    const score = matchesQuery(item);
    if (score) candidates.push({ ...item, score });
  });
  const archive = await loadArchiveIndex();
  archive.filter(item => !courseId || item.courseId === courseId).forEach(item => {
    const score = matchesQuery(item);
    if (score) candidates.push({ ...item, score, type: "pdf" });
  });
  candidates.sort((left, right) => right.score - left.score);
  const best = candidates[0];
  if (!best) {
    throw new Error("Belum ada jawaban yang cocok di materi tersimpan. Coba pilih mata kuliah lain atau unggah PDF teks.");
  }
  const excerpts = rankIndexedSentences(best.sentences, queryTerms, 4);
  if (!excerpts.length && best.type === "pdf") excerpts.push(...best.summary.bullets.slice(0, 3));
  if (!excerpts.length) throw new Error("Tidak ditemukan kutipan yang cukup relevan pada materi tersebut.");
  return {
    answer: `Aku menemukan materi yang berkaitan pada ${best.title} (${best.courseName}):\n\n${excerpts.map(text => `• ${text}`).join("\n")}\n\nIni pencarian berdasarkan materi lokal, bukan jawaban AI generatif. Gunakan rangkuman sebagai panduan belajar dan cocokkan dengan bahan dari dosen.`,
    sources: [{ type: best.type, course: best.courseName, title: best.title, concepts: best.concepts }]
  };
};

window.askWenAI = async (question, onAnswer = null) => {
  if (wenBusy) {
    setStatus($("#wenStatus"), "Wen.AI masih menyusun jawaban sebelumnya. Tunggu sebentar lalu coba lagi.", "error");
    return null;
  }
  wenBusy = true;
  const status = $("#wenStatus");
  const send = $("#wenForm button[type=submit]");
  const input = $("#wenInput");
  $("#wenMessages").querySelector(".wen-loading")?.remove();
  const waiting = document.createElement("p");
  waiting.className = "wen-message wen-loading";
  waiting.textContent = "Mencari jawaban di materi yang tersimpan di perangkat ini…";
  $("#wenMessages").append(waiting);
  $("#wenMessages").scrollTop = $("#wenMessages").scrollHeight;
  setStatus(status, "Mencari kutipan paling relevan di materi lokal…");
  send.disabled = true;
  input.disabled = true;
  try {
    await new Promise(resolve => requestAnimationFrame(resolve));
    const result = await askWenAI(question);
    waiting.remove();
    if (onAnswer) onAnswer(result.answer);
    else appendWenMessage(result.answer, "assistant", result.sources);
    if (onAnswer) addSourceChips($("#wenMessages").lastElementChild, result.sources, result.answer);
    if (!onAnswer) setStatus(status, "Jawaban dicocokkan dengan materi lokal; ini bukan jawaban AI generatif.");
    return result;
  } catch (error) {
    waiting.remove();
    console.error("Wen.AI gagal menjawab:", error);
    if (onAnswer) {
      appendWenMessage(error.message, "assistant");
      setStatus(status, "Belum ditemukan jawaban yang cocok di materi tersimpan.");
    } else {
      appendWenMessage(error.message, "assistant");
      setStatus(status, "Periksa pertanyaan atau unggah PDF yang relevan.");
    }
    return null;
  } finally {
    send.disabled = false;
    input.disabled = false;
    wenBusy = false;
  }
};

const normalize = normalizeStudyText;

const createElement = (tag, className, text) => {
  const element = document.createElement(tag);
  if (className) element.className = className;
  if (text !== undefined) element.textContent = text;
  return element;
};

const selectCourse = course => {
  activeCourse = course;
  activeLesson = 0;
  $$(".course-card", courseGrid).forEach(button => {
    button.setAttribute("aria-pressed", String(button.dataset.courseId === course.id));
  });
  uploadCourse.value = course.id;
  wenCourseSelect.value = course.id;
  renderLesson();
  loadUploaded(course.id);
};

const renderCourseCards = (query = "") => {
  const search = normalize(query);
  const visible = courses.filter(course => {
    const haystack = normalize([
      course.name,
      course.day,
      course.room,
      course.summary,
      ...course.lessons.flatMap(lesson => [lesson.title, lesson.body, ...lesson.concepts])
    ].join(" "));
    return !search || search.split(/\s+/).every(term => haystack.includes(term));
  });
  courseGrid.replaceChildren();
  visible.forEach(course => {
    const button = createElement("button", "course-card");
    button.type = "button";
    button.dataset.courseId = course.id;
    button.style.setProperty("--course-accent", course.accent);
    button.setAttribute("aria-pressed", String(activeCourse?.id === course.id));
    const icon = createElement("span", "course-icon", course.icon);
    const name = createElement("strong", "", course.name);
    const schedule = createElement("small", "", `${course.day} · ${course.time} · ${course.room}`);
    button.append(icon, name, schedule);
    button.addEventListener("click", () => selectCourse(course));
    button.addEventListener("pointermove", event => {
      const rect = button.getBoundingClientRect();
      button.style.setProperty("--course-rx", `${((event.clientY - rect.top) / rect.height - 0.5) * -5}deg`);
      button.style.setProperty("--course-ry", `${((event.clientX - rect.left) / rect.width - 0.5) * 7}deg`);
      button.style.setProperty("--course-x", `${event.clientX - rect.left}px`);
      button.style.setProperty("--course-y", `${event.clientY - rect.top}px`);
    });
    button.addEventListener("pointerleave", () => {
      button.style.setProperty("--course-rx", "0deg");
      button.style.setProperty("--course-ry", "0deg");
    });
    courseGrid.append(button);
  });
  $("#learningCount").textContent = `${String(visible.length).padStart(2, "0")} / ${courses.length} MATA KULIAH`;
  if (search && visible.length === 0) $("#learningCount").textContent = "TIDAK ADA MATERI YANG COCOK";
};

const renderHologram = (lesson, course) => {
  const stage = $(".lesson-hologram", lessonDetail);
  if (!stage) return;
  const graph = createElement("div", "holo-graph");
  graph.setAttribute("aria-label", `Hologram konsep ${lesson.title}`);
  const svg = document.createElementNS("http://www.w3.org/2000/svg", "svg");
  svg.classList.add("holo-lines");
  svg.setAttribute("viewBox", "0 0 520 190");
  svg.setAttribute("aria-hidden", "true");
  const positions = [[260, 95], [86, 54], [175, 25], [347, 29], [432, 60], [368, 145], [155, 148]];
  for (let i = 1; i < Math.min(positions.length, lesson.concepts.length + 1); i++) {
    const line = document.createElementNS("http://www.w3.org/2000/svg", "line");
    line.setAttribute("x1", positions[0][0]);
    line.setAttribute("y1", positions[0][1]);
    line.setAttribute("x2", positions[i][0]);
    line.setAttribute("y2", positions[i][1]);
    svg.append(line);
  }
  graph.append(svg, createElement("span", "holo-core"));
  lesson.concepts.slice(0, 6).forEach((concept, index) => {
    const node = createElement("span", "holo-node", concept);
    node.style.left = `calc(${positions[index + 1][0] / 520 * 100}% - 34px)`;
    node.style.top = `calc(${positions[index + 1][1] / 190 * 100}% - 34px)`;
    node.style.setProperty("--holo-depth", `${14 + index % 3 * 9}px`);
    graph.append(node);
  });
  stage.replaceChildren(createElement("div", "holo-floor"), graph);
  stage.addEventListener("pointermove", event => {
    if (event.pointerType === "touch") return;
    const rect = stage.getBoundingClientRect();
    graph.style.setProperty("--holo-rx", `${((event.clientY - rect.top) / rect.height - 0.5) * -13}deg`);
    graph.style.setProperty("--holo-ry", `${((event.clientX - rect.left) / rect.width - 0.5) * 18}deg`);
  });
  stage.addEventListener("pointerleave", () => {
    graph.style.setProperty("--holo-rx", "0deg");
    graph.style.setProperty("--holo-ry", "0deg");
  });
};

const renderLesson = () => {
  if (!activeCourse) return;
  const course = activeCourse;
  const lesson = course.lessons[activeLesson] || course.lessons[0];
  const header = createElement("div", "course-detail-head");
  const heading = document.createElement("div");
  heading.append(
    createElement("p", "eyebrow", `${course.day.toUpperCase()} · ${course.time} · ${course.room.toUpperCase()}`),
    createElement("h3", "", course.name),
    createElement("p", "", course.summary)
  );
  header.append(heading, createElement("span", "course-orbit-mark", course.icon));
  const hologram = createElement("div", "lesson-hologram");
  hologram.setAttribute("aria-label", `Hologram interaktif: ${lesson.title}`);
  const list = createElement("div", "lesson-list");
  course.lessons.forEach((item, index) => {
    const article = createElement("article", "lesson-item");
    article.tabIndex = 0;
    article.setAttribute("aria-current", String(index === activeLesson));
    const title = createElement("h4", "", `${String(index + 1).padStart(2, "0")} / ${item.title}`);
    const body = createElement("p", "", item.body);
    const concepts = createElement("div", "lesson-concepts");
    item.concepts.forEach(concept => concepts.append(createElement("span", "", concept)));
    const actions = createElement("div", "lesson-actions");
    const focus = createElement("button", "lesson-focus", index === activeLesson ? "⟲ Hologram aktif" : "◉ Tampilkan hologram");
    focus.type = "button";
    focus.addEventListener("click", () => {
      activeLesson = index;
      renderLesson();
    });
    const ask = createElement("button", "lesson-ask", "✧ Cari jawaban di materi ini");
    ask.type = "button";
    ask.addEventListener("click", () => {
      activeLesson = index;
      window.openWenAssistant(course.id, `Jelaskan "${item.title}" pada mata kuliah ${course.name}. Beri penjelasan runtut, contoh sederhana, lalu satu pertanyaan latihan.`);
    });
    actions.append(focus, ask);
    article.append(title, body, concepts, actions);
    list.append(article);
  });
  lessonDetail.replaceChildren(header, hologram, list);
  renderHologram(lesson, course);
};

const renderUploaded = materials => {
  archiveObjectUrls.forEach(url => URL.revokeObjectURL(url));
  archiveObjectUrls.clear();
  uploadedList.replaceChildren();
  if (!materials.length) {
    uploadedList.append(createElement("span", "", "Belum ada PDF tersimpan di browser ini."));
    return;
  }
  materials.forEach(material => {
    const item = createElement("article", "uploaded-item");
    item.append(
      createElement("strong", "", material.filename),
      createElement("span", "", `${material.courseName} · ${material.pages} hlm.`)
    );
    const actions = createElement("div", "archive-actions");
    const summaryToggle = createElement("button", "uploaded-open", "BUKA RANGKUMAN UTS");
    summaryToggle.type = "button";
    summaryToggle.setAttribute("aria-expanded", "false");
    const open = createElement("button", "uploaded-open", "UNDUH PDF ↗");
    open.type = "button";
    open.addEventListener("click", async () => {
      open.disabled = true;
      try {
        const stored = await readArchiveItem(material.id);
        if (!stored) throw new Error("File PDF tidak ditemukan di arsip browser.");
        const url = URL.createObjectURL(stored.file);
        archiveObjectUrls.add(url);
        const link = createElement("a");
        link.href = url;
        link.download = material.filename;
        link.click();
        window.setTimeout(() => {
          URL.revokeObjectURL(url);
          archiveObjectUrls.delete(url);
        }, 60_000);
      } catch (error) {
        setStatus(uploadStatus, error.message, "error");
      } finally {
        open.disabled = false;
      }
    });
    const download = createElement("button", "uploaded-open", "UNDUH CATATAN");
    download.type = "button";
    download.addEventListener("click", () => {
      const note = [
        `RANGKUMAN POKOK UTS`,
        `${material.courseName} · ${material.filename}`,
        "",
        "MATERI POKOK",
        ...material.summary.bullets.map(bullet => `- ${bullet}`),
        "",
        "KONSEP KUNCI",
        material.summary.concepts.join(", "),
        "",
        "LATIHAN MANDIRI",
        ...material.summary.questions.map((question, index) => `${index + 1}. ${question}`)
      ].join("\n");
      const url = URL.createObjectURL(new Blob([note], { type: "text/plain;charset=utf-8" }));
      const link = createElement("a");
      link.href = url;
      link.download = `${material.filename.replace(/\.pdf$/i, "")}-rangkuman-uts.txt`;
      link.click();
      window.setTimeout(() => URL.revokeObjectURL(url), 1000);
    });
    const remove = createElement("button", "uploaded-open", "HAPUS");
    remove.type = "button";
    remove.addEventListener("click", async () => {
      remove.disabled = true;
      try {
        await deleteArchiveItem(material.id);
        setStatus(uploadStatus, `PDF ${material.filename} dan rangkumannya dihapus dari browser ini.`, "success");
        await loadUploaded(uploadCourse.value, courseSearch.value.trim());
      } catch (error) {
        remove.disabled = false;
        setStatus(uploadStatus, error.message, "error");
      }
    });
    actions.append(summaryToggle, download, open, remove);
    const summary = createElement("section", "archive-summary");
    summary.hidden = true;
    summary.append(createElement("h4", "", "MATERI POKOK UTS"));
    const keyPoints = document.createElement("ul");
    material.summary.bullets.forEach(bullet => keyPoints.append(createElement("li", "", bullet)));
    summary.append(keyPoints, createElement("h4", "", "KONSEP KUNCI"));
    const conceptList = createElement("div", "lesson-concepts");
    material.summary.concepts.forEach(concept => conceptList.append(createElement("span", "", concept)));
    summary.append(conceptList, createElement("h4", "", "LATIHAN MANDIRI"));
    const questions = document.createElement("ol");
    material.summary.questions.forEach(question => questions.append(createElement("li", "", question)));
    summary.append(questions, createElement("p", "archive-disclaimer", "Rangkuman otomatis berbasis teks PDF, bukan analisis AI. Periksa kembali dengan materi dan arahan dosen."));
    summaryToggle.addEventListener("click", () => {
      summary.hidden = !summary.hidden;
      summaryToggle.setAttribute("aria-expanded", String(!summary.hidden));
      summaryToggle.textContent = summary.hidden ? "BUKA RANGKUMAN UTS" : "TUTUP RANGKUMAN";
    });
    item.append(actions, summary);
    uploadedList.append(item);
  });
};

const loadUploaded = async (courseId = "", query = "") => {
  try {
    const materials = await loadArchiveIndex();
    const search = new Set(studyTerms(query));
    const filtered = materials.filter(material => {
      const matchesCourse = !courseId || material.courseId === courseId;
      return matchesCourse && [...search].every(term => material.termSet.has(term));
    });
    renderUploaded(filtered.sort((left, right) => right.uploadedAt - left.uploadedAt));
  } catch (error) {
    renderUploaded([]);
    console.error("Arsip materi lokal gagal dimuat:", error);
    setStatus(uploadStatus, error.message, "error");
  }
};

const populateSelects = () => {
  for (const select of [uploadCourse, wenCourseSelect]) {
    const placeholder = select.options[0];
    select.replaceChildren(placeholder);
    courses.forEach(course => {
      const option = document.createElement("option");
      option.value = course.id;
      option.textContent = `${course.name} · ${course.day} ${course.time}`;
      select.append(option);
    });
  }
};

const initializeLearning = async () => {
  loadArchiveIndex().catch(error => {
    console.error("Indeks arsip lokal gagal disiapkan:", error);
    setStatus($("#wenStatus"), `Indeks pencarian lokal tidak dapat disiapkan: ${error.message}`, "error");
  });
  try {
    const response = await fetch(new URL("./courses.json", import.meta.url));
    if (!response.ok) throw new Error("Katalog mata kuliah tidak dapat dimuat.");
    courses = await response.json();
    lessonIndex = courses.flatMap(course => course.lessons.map(lesson => {
      const index = createSearchIndex({
        title: lesson.title,
        courseName: course.name,
        text: `${lesson.title}. ${lesson.body}`,
        concepts: lesson.concepts
      });
      return {
        courseId: course.id,
        courseName: course.name,
        title: lesson.title,
        concepts: lesson.concepts,
        type: "lesson",
        ...index,
        termSet: new Set(index.terms)
      };
    }));
    populateSelects();
    renderCourseCards();
    selectCourse(courses[0]);
    wenCourseSelect.value = "";
  } catch (error) {
    $("#learningCount").textContent = "KATALOG GAGAL DIMUAT";
    lessonDetail.replaceChildren(createElement("p", "learning-error", `${error.message} Pastikan file courses.json ikut diunggah ke GitHub Pages.`));
    console.error("Materi pembelajaran gagal dimuat:", error);
  }
};

courseSearch.addEventListener("input", () => {
  renderCourseCards(courseSearch.value);
  clearTimeout(searchTimer);
  searchTimer = window.setTimeout(() => loadUploaded("", courseSearch.value.trim()), 220);
});

uploadCourse.addEventListener("change", () => {
  if (!courseSearch.value) loadUploaded(uploadCourse.value);
});

$("#pdfFile").addEventListener("change", event => {
  const file = event.target.files?.[0];
  $("#pdfFileName").textContent = file ? `${file.name} · ${(file.size / (1024 * 1024)).toFixed(1)} MB` : "PILIH PDF BAHAN UTS";
});

$("#pdfUploadForm").addEventListener("submit", async event => {
  event.preventDefault();
  const form = event.currentTarget;
  const button = $(".upload-button");
  const file = $("#pdfFile").files?.[0];
  const course = courses.find(item => item.id === uploadCourse.value);
  if (!file || !course) {
    setStatus(uploadStatus, "Pilih mata kuliah dan file PDF terlebih dahulu.", "error");
    return;
  }
  button.disabled = true;
  setStatus(uploadStatus, "Membaca PDF di browser dan menyusun materi pokok…");
  try {
    const { text, pages } = await extractPdfText(file);
    const summary = summarizeStudyNotes(text);
    const material = {
      id: crypto.randomUUID(),
      courseId: course.id,
      courseName: course.name,
      filename: file.name,
      uploadedAt: Date.now(),
      pages,
      text,
      summary,
      file
    };
    await saveArchiveItem(material);
    setStatus(uploadStatus, `PDF berhasil diproses di perangkat ini. ${summary.bullets.length} materi pokok dan ${summary.questions.length} latihan mandiri siap dipelajari.`, "success");
    form.reset();
    $("#pdfFileName").textContent = "PILIH PDF BAHAN UTS";
    await loadUploaded(uploadCourse.value, courseSearch.value.trim());
  } catch (error) {
    console.error("PDF gagal diproses di browser:", error);
    setStatus(uploadStatus, error.message, "error");
  } finally {
    button.disabled = false;
  }
});

window.openWenAssistant = (courseId, question = "") => {
  const panel = $("#wenPanel");
  if (courseId && courses.length) wenCourseSelect.value = courseId;
  panel.hidden = false;
  $("#wenToggle").setAttribute("aria-expanded", "true");
  $("#wenInput").value = question;
  $("#wenInput").focus();
  panel.scrollIntoView({ block: "nearest" });
};

window.searchWenMaterials = async query => {
  const archive = await loadArchiveIndex();
  const terms = new Set(studyTerms(query));
  const queryTerms = [...terms];
  return [...lessonIndex, ...archive]
    .map(item => ({
      item,
      score: queryTerms.reduce((total, term) => total + Number(item.termSet.has(term)), 0)
    }))
    .filter(result => result.score > 0)
    .sort((left, right) => right.score - left.score)
    .slice(0, 8)
    .map(({ item }) => ({
      title: item.title || item.filename,
      course: item.courseName,
      summary: item.summary || { bullets: item.sentences.map(sentence => sentence.text), concepts: item.concepts }
    }));
};

courseGrid.addEventListener("click", event => {
  if (event.target.closest(".course-card")) $("#learning").scrollIntoView({ behavior: reducedMotion ? "auto" : "smooth", block: "start" });
});

if (!reducedMotion && "IntersectionObserver" in window) {
  const learningReveal = new IntersectionObserver(entries => {
    entries.forEach(entry => {
      if (!entry.isIntersecting) return;
      entry.target.classList.add("in");
      learningReveal.unobserve(entry.target);
    });
  }, { threshold: 0.1 });
  $$(".learning-section .reveal").forEach(element => learningReveal.observe(element));
}

initializeLearning();

const initialiseSolarSystem = async () => {
  const root = $("#solarSystem");
  try {
    const THREE = await import("https://cdn.jsdelivr.net/npm/three@0.180.0/build/three.module.js");
    const scene = new THREE.Scene();
    const camera = new THREE.PerspectiveCamera(38, 1, 0.1, 100);
    const renderer = new THREE.WebGLRenderer({ alpha: true, antialias: true, powerPreference: "low-power" });
    renderer.setPixelRatio(Math.min(devicePixelRatio, 1.7));
    renderer.setClearColor(0x000000, 0);
    renderer.outputColorSpace = THREE.SRGBColorSpace;
    renderer.toneMapping = THREE.ACESFilmicToneMapping;
    renderer.toneMappingExposure = 1.25;
    root.prepend(renderer.domElement);
    scene.add(new THREE.AmbientLight(0x6072bb, 1.2));
    const planetFillLight = new THREE.HemisphereLight(0x9feaff, 0x10152b, 1.8);
    scene.add(planetFillLight);
    const sunLight = new THREE.PointLight(0xffd08a, 180, 60, 1.7);
    scene.add(sunLight);
    const textureLoader = new THREE.TextureLoader();
    const textureBase = "https://threejs.org/examples/textures/planets/";
    const getTexture = (filename, colorSpace = THREE.SRGBColorSpace) => textureLoader.load(`${textureBase}${filename}`, texture => {
      texture.colorSpace = colorSpace;
    }, undefined, () => console.warn(`Tekstur planet tidak tersedia: ${filename}`));
    const makePlanetTexture = (base, highlight, style) => {
      const canvas = document.createElement("canvas");
      canvas.width = 512;
      canvas.height = 256;
      const context = canvas.getContext("2d");
      const gradient = context.createLinearGradient(0, 0, 0, 256);
      gradient.addColorStop(0, highlight);
      gradient.addColorStop(0.52, base);
      gradient.addColorStop(1, "#101526");
      context.fillStyle = gradient;
      context.fillRect(0, 0, 512, 256);
      let seed = style * 8191 + 73;
      const random = () => {
        seed = (seed * 16807) % 2147483647;
        return (seed - 1) / 2147483646;
      };
      for (let i = 0; i < 100; i++) {
        const y = random() * 256;
        const height = style === 5 ? 1 + random() * 8 : 2 + random() * 16;
        context.fillStyle = i % 3 === 0 ? `${highlight}34` : `${base}30`;
        if (style === 5 || style === 6 || style === 7) {
          context.fillRect(0, y, 512, height);
        } else {
          context.beginPath();
          context.ellipse(random() * 512, y, 5 + random() * 35, 2 + random() * 9, random(), 0, Math.PI * 2);
          context.fill();
        }
      }
      if (style === 0) {
        const flare = context.createRadialGradient(350, 122, 2, 350, 122, 110);
        flare.addColorStop(0, "#fff6ba");
        flare.addColorStop(0.18, "#ffce66");
        flare.addColorStop(0.55, "#fd6d31");
        flare.addColorStop(1, "transparent");
        context.globalCompositeOperation = "screen";
        context.fillStyle = flare;
        context.fillRect(0, 0, 512, 256);
        context.globalCompositeOperation = "source-over";
      } else if (style === 4) {
        context.fillStyle = "rgba(169,67,55,.86)";
        context.beginPath();
        context.ellipse(350, 155, 34, 15, -0.1, 0, Math.PI * 2);
        context.fill();
      } else if (style === 1) {
        for (let i = 0; i < 95; i++) {
          const x = random() * 512;
          const y = random() * 256;
          const radius = 1 + random() * 9;
          context.fillStyle = `rgba(22,27,39,${0.08 + random() * 0.26})`;
          context.beginPath();
          context.arc(x, y, radius, 0, Math.PI * 2);
          context.fill();
        }
      }
      const texture = new THREE.CanvasTexture(canvas);
      texture.colorSpace = THREE.SRGBColorSpace;
      return texture;
    };
    const makeEarthTexture = () => {
      const canvas = document.createElement("canvas");
      canvas.width = 512;
      canvas.height = 256;
      const context = canvas.getContext("2d");
      const ocean = context.createLinearGradient(0, 0, 0, 256);
      ocean.addColorStop(0, "#5dd7f2");
      ocean.addColorStop(0.32, "#167ac3");
      ocean.addColorStop(0.72, "#10569e");
      ocean.addColorStop(1, "#8bd7ed");
      context.fillStyle = ocean;
      context.fillRect(0, 0, 512, 256);
      context.fillStyle = "#61bd73";
      const landmasses = [
        [[64, 35], [95, 24], [122, 35], [144, 47], [138, 64], [119, 73], [113, 91], [91, 101], [82, 82], [63, 74], [51, 54]],
        [[139, 99], [162, 105], [176, 124], [169, 147], [183, 166], [171, 200], [153, 182], [146, 153], [132, 134]],
        [[237, 38], [273, 27], [310, 37], [329, 55], [360, 56], [375, 75], [349, 86], [325, 76], [304, 95], [282, 90], [266, 106], [249, 83], [228, 66]],
        [[250, 99], [278, 97], [294, 119], [286, 146], [273, 177], [254, 160], [243, 132]],
        [[363, 159], [391, 153], [416, 167], [408, 184], [385, 190], [368, 179]],
        [[428, 102], [445, 96], [455, 108], [448, 119], [434, 116]]
      ];
      landmasses.forEach(points => {
        context.beginPath();
        context.moveTo(...points[0]);
        points.slice(1).forEach(point => context.lineTo(...point));
        context.closePath();
        context.fill();
      });
      context.strokeStyle = "rgba(238,252,255,.2)";
      context.lineWidth = 5;
      for (let index = 0; index < 42; index++) {
        const x = (index * 79) % 512;
        const y = 20 + ((index * 43) % 210);
        context.beginPath();
        context.ellipse(x, y, 9 + (index % 5) * 5, 2 + (index % 3), -0.28, 0, Math.PI * 1.25);
        context.stroke();
      }
      const texture = new THREE.CanvasTexture(canvas);
      texture.colorSpace = THREE.SRGBColorSpace;
      return texture;
    };
    const solarPivot = new THREE.Group();
    solarPivot.position.x = innerWidth <= 860 ? 0 : 1.45;
    scene.add(solarPivot);
    sunLight.position.x = solarPivot.position.x;
    const sunGeometry = new THREE.SphereGeometry(0.95, 48, 48);
    const sunMaterial = new THREE.MeshBasicMaterial({ map: makePlanetTexture("#f56e25", "#fff1ad", 0), color: 0xffe1aa });
    const sun = new THREE.Mesh(sunGeometry, sunMaterial);
    solarPivot.add(sun);
    const solarLabelTargets = [{ name: "MATAHARI", object: sun }];
    const corona = new THREE.Mesh(
      new THREE.SphereGeometry(1.04, 48, 48),
      new THREE.MeshBasicMaterial({ color: 0xff962e, transparent: true, opacity: 0.15, side: THREE.BackSide })
    );
    sun.add(corona);

    const planets = [
      { name: "Merkurius", radius: 1.45, size: 0.095, color: 0xa9a19b, textureStyle: 1, speed: 0.42 },
      { name: "Venus", radius: 2.45, size: 0.14, color: 0xe7bb7a, textureStyle: 2, speed: 0.3 },
      { name: "Bumi", radius: 3.5, size: 0.68, color: 0xffffff, texture: "earth_atmos_2048.jpg", speed: 0.22 },
      { name: "Mars", radius: 4.95, size: 0.13, color: 0xe77c55, textureStyle: 3, speed: 0.17 },
      { name: "Jupiter", radius: 5.9, size: 0.36, color: 0xd9b18b, textureStyle: 4, speed: 0.1 },
      { name: "Saturnus", radius: 7, size: 0.31, color: 0xe4d2a2, textureStyle: 5, speed: 0.075, rings: true },
      { name: "Uranus", radius: 8.05, size: 0.22, color: 0x9ae6e8, textureStyle: 6, speed: 0.055 },
      { name: "Neptunus", radius: 9.1, size: 0.21, color: 0x617de8, textureStyle: 7, speed: 0.042 }
    ];
    const planetGroups = planets.map((planet, index) => {
      const orbit = new THREE.Mesh(
        new THREE.RingGeometry(planet.radius - 0.003, planet.radius + 0.003, 180),
        new THREE.MeshBasicMaterial({ color: index === 2 ? 0x55ddff : 0x8f99d6, transparent: true, opacity: index === 2 ? 0.26 : 0.12, side: THREE.DoubleSide })
      );
      orbit.rotation.x = Math.PI / 2;
      solarPivot.add(orbit);
      const group = new THREE.Group();
      group.rotation.y = index * 0.73;
      solarPivot.add(group);
      const planetMaterial = new THREE.MeshStandardMaterial({
          color: planet.color,
          map: planet.name === "Bumi"
            ? makeEarthTexture()
            : planet.texture
              ? getTexture(planet.texture)
              : makePlanetTexture(`#${planet.color.toString(16).padStart(6, "0")}`, "#fff0ce", planet.textureStyle),
          roughness: 0.86,
          metalness: 0.02
        });
      if (planet.name === "Bumi") {
        planetMaterial.roughness = 0.72;
        planetMaterial.emissive.set(0x082c4a);
        planetMaterial.emissiveIntensity = 0.45;
      }
      const mesh = new THREE.Mesh(new THREE.SphereGeometry(planet.size, planet.name === "Bumi" ? 64 : 48, planet.name === "Bumi" ? 64 : 48), planetMaterial);
      mesh.position.set(planet.radius, 0, 0);
      mesh.userData.label = planet.name;
      group.add(mesh);
      solarLabelTargets.push({ name: planet.name.toLocaleUpperCase("id-ID"), object: mesh });
      if (planet.name === "Bumi") {
        const atmosphere = new THREE.Mesh(
          new THREE.SphereGeometry(planet.size * 1.18, 48, 48),
          new THREE.MeshBasicMaterial({ color: 0x46cfff, transparent: true, opacity: 0.3, side: THREE.BackSide })
        );
        mesh.add(atmosphere);
        const moonGroup = new THREE.Group();
        moonGroup.position.copy(mesh.position);
        group.add(moonGroup);
        const moonOrbit = new THREE.Mesh(
          new THREE.RingGeometry(0.89, 0.91, 96),
          new THREE.MeshBasicMaterial({ color: 0xd9e7ff, transparent: true, opacity: 0.2, side: THREE.DoubleSide })
        );
        moonOrbit.rotation.x = Math.PI / 2;
        moonGroup.add(moonOrbit);
        const moon = new THREE.Mesh(
          new THREE.SphereGeometry(0.09, 24, 24),
          new THREE.MeshStandardMaterial({ map: getTexture("moon_1024.jpg"), color: 0xe6edf6, roughness: 1 })
        );
        moon.position.x = 0.9;
        moonGroup.add(moon);
        solarLabelTargets.push({ name: "BULAN", object: moon });
        group.userData.moon = moonGroup;
      }
      if (planet.rings) {
        const rings = new THREE.Mesh(
          new THREE.RingGeometry(planet.size * 1.25, planet.size * 1.85, 96),
          new THREE.MeshStandardMaterial({ color: 0xd9c28a, transparent: true, opacity: 0.65, side: THREE.DoubleSide, roughness: 1 })
        );
        rings.rotation.x = Math.PI / 2.35;
        mesh.add(rings);
      }
      group.userData.speed = planet.speed;
      return group;
    });
    const labels = document.createElement("div");
    labels.className = "solar-labels";
    const labelItems = solarLabelTargets.map((target, index) => {
      const element = document.createElement("span");
      element.className = "solar-object-label";
      if (target.name === "BUMI") element.classList.add("earth-object-label");
      element.textContent = target.name;
      labels.append(element);
      return { ...target, element, index };
    });
    root.append(labels);

    const starPositions = new Float32Array(1800 * 3);
    for (let i = 0; i < starPositions.length; i += 3) {
      starPositions[i] = (Math.random() - 0.5) * 40;
      starPositions[i + 1] = (Math.random() - 0.5) * 26;
      starPositions[i + 2] = (Math.random() - 0.5) * 25 - 3;
    }
    const starGeometry = new THREE.BufferGeometry();
    starGeometry.setAttribute("position", new THREE.BufferAttribute(starPositions, 3));
    const stars = new THREE.Points(starGeometry, new THREE.PointsMaterial({ color: 0xa6dfff, size: 0.018, transparent: true, opacity: 0.86 }));
    scene.add(stars);

    const cameraBaseY = 1.8;
    camera.position.set(0, cameraBaseY, 12);
    camera.lookAt(0, 0, 0);
    const labelPosition = new THREE.Vector3();
    let drag = null;
    let pointer = { x: 0, y: 0 };
    renderer.domElement.addEventListener("pointerdown", event => {
      drag = { x: event.clientX, y: event.clientY, px: event.clientX, py: event.clientY };
      renderer.domElement.setPointerCapture(event.pointerId);
    });
    renderer.domElement.addEventListener("pointermove", event => {
      pointer.x = (event.clientX / innerWidth - 0.5) * 0.8;
      pointer.y = (event.clientY / innerHeight - 0.5) * 0.5;
      if (!drag) return;
      solarPivot.rotation.y += (event.clientX - drag.px) * 0.004;
      solarPivot.rotation.x = THREE.MathUtils.clamp(solarPivot.rotation.x + (event.clientY - drag.py) * 0.002, -0.6, 0.6);
      drag.px = event.clientX;
      drag.py = event.clientY;
    });
    renderer.domElement.addEventListener("pointerup", () => { drag = null; });
    renderer.domElement.addEventListener("pointercancel", () => { drag = null; });

    const resize = () => {
      const width = Math.max(root.clientWidth, 1);
      const height = Math.max(root.clientHeight, 1);
      const aspect = width / height;
      renderer.setSize(width, height, false);
      camera.aspect = aspect;
      solarPivot.position.x = innerWidth <= 860 ? 0 : 1.45;
      sunLight.position.x = solarPivot.position.x;
      camera.position.z = Math.max(9, 16.5 / (2 * Math.tan(THREE.MathUtils.degToRad(camera.fov / 2)) * aspect));
      camera.position.y = aspect < 0.8 ? 2.4 : cameraBaseY;
      camera.updateProjectionMatrix();
    };
    const resizeObserver = new ResizeObserver(resize);
    resizeObserver.observe(root);
    resize();

    let visible = true;
    let animationFrame = 0;
    const visibility = new IntersectionObserver(entries => {
      visible = entries[0].isIntersecting;
      if (visible && !animationFrame) animate();
    });
    visibility.observe(root);
    const animate = () => {
      if (!visible) {
        animationFrame = 0;
        return;
      }
      animationFrame = requestAnimationFrame(animate);
      const time = performance.now() * 0.001;
      if (!reducedMotion) {
        planetGroups.forEach((group, index) => {
          group.rotation.y += group.userData.speed * 0.0085;
          if (group.userData.moon) group.userData.moon.rotation.y = time * 1.05;
          const planetMesh = group.children.find(child => child.isMesh && child.geometry.type === "SphereGeometry");
          if (planetMesh) planetMesh.rotation.y += 0.006 + index * 0.0003;
        });
        sun.rotation.y += 0.0024;
        const coronaPulse = 1 + Math.sin(time * 2.2) * 0.055;
        corona.scale.setScalar(coronaPulse);
        corona.material.opacity = 0.13 + Math.sin(time * 2.2) * 0.035;
        stars.rotation.y = Math.sin(time * 0.025) * 0.045;
        camera.position.x += (pointer.x * 2.5 - camera.position.x) * 0.018;
        camera.position.y += (cameraBaseY - pointer.y * 2 - camera.position.y) * 0.018;
        camera.lookAt(0, 0, 0);
      }
      camera.updateMatrixWorld();
      labelItems.forEach(item => {
        item.object.getWorldPosition(labelPosition);
        labelPosition.project(camera);
        const visible = labelPosition.z > -1 && labelPosition.z < 1;
        item.element.hidden = !visible;
        if (visible) {
          const offsetY = [-30, -10, 10, 30, -30, -10, 10, 30, -30, -10][item.index];
          const left = THREE.MathUtils.clamp((labelPosition.x * 0.5 + 0.5) * root.clientWidth, 44, root.clientWidth - 44);
          const top = THREE.MathUtils.clamp(
            (-labelPosition.y * 0.5 + 0.5) * root.clientHeight + offsetY,
            18,
            Math.max(18, root.clientHeight - 38)
          );
          item.element.style.left = `${left}px`;
          item.element.style.top = `${top}px`;
        }
      });
      renderer.render(scene, camera);
    };
    root.classList.add("is-ready");
    animate();
    document.addEventListener("visibilitychange", () => {
      visible = document.visibilityState === "visible" && root.getBoundingClientRect().bottom > 0 && root.getBoundingClientRect().top < innerHeight;
      if (visible && !animationFrame) animate();
    });
  } catch (error) {
    console.error("Visualisasi tata surya 3D tidak dapat dimuat:", error);
    root.dataset.state = "fallback";
    const hint = $(".solar-hint", root);
    if (hint) hint.textContent = "VISUAL 3D TERSEDIA SAAT KONEKSI CDN AKTIF · DRAG UNTUK MENJELAJAHI";
  }
};

initialiseSolarSystem();
