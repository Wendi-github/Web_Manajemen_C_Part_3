const STOP_WORDS = new Set(
  "a about above ada adalah agar akan anda any apakah apabila atas bagi bahkan bahwa be been sebelum belum berikut berupa between bisa both buat but by can could dari dalam dan dengan di do does doing during efek for from further harus i if in into is it its jadi juga just karena ke kepada ketika kita kurang lebih maka menjadi melalui measure measures masih may mengapa memang mikro mungkin most must nanti no nor of on only or organizational org pada paling per perlu saat sama sangat sebagai sebuah secara serta setelah sebelum setiap sudah such supaya telah tentang the their them there these they this those through untuk use used uses menggunakan via we were while with without waktu yang you yakni yaitu".split(" ")
);

export const normalizeStudyText = value => value
  .toLocaleLowerCase("id-ID")
  .normalize("NFD")
  .replace(/[\u0300-\u036f]/g, "");

export const studyTerms = value => normalizeStudyText(value)
  .match(/[\p{L}\p{N}]{3,}/gu)
  ?.filter(term => !STOP_WORDS.has(term)) || [];

const splitSentences = text => text
  .replace(/([.!?])(?=\s|$)/g, "$1\n")
  .split(/\r?\n/)
  .map(sentence => sentence.replace(/\s+/g, " ").trim())
  .filter(sentence => sentence.length >= 45 && studyTerms(sentence).length >= 6);

export const createSearchIndex = ({ title, courseName, text, concepts = [] }) => {
  const sentences = splitSentences(text).map(sentence => ({
    text: sentence,
    terms: [...new Set(studyTerms(sentence))]
  }));
  const terms = [...new Set([
    ...studyTerms(title),
    ...studyTerms(courseName),
    ...studyTerms(concepts.join(" ")),
    ...sentences.flatMap(sentence => sentence.terms)
  ])];
  return { terms, sentences };
};

export const createPdfSearchEntry = item => {
  const searchableText = item.summary.bullets.join(" ");
  const index = createSearchIndex({
    title: item.filename,
    courseName: item.courseName,
    text: searchableText,
    concepts: item.summary.concepts
  });
  return {
    id: item.id,
    courseId: item.courseId,
    courseName: item.courseName,
    filename: item.filename,
    uploadedAt: item.uploadedAt,
    pages: item.pages,
    summary: item.summary,
    terms: index.terms,
    sentences: index.sentences
  };
};

export const rankIndexedSentences = (sentences, queryTerms, limit = 4) => {
  const terms = queryTerms instanceof Set ? queryTerms : new Set(queryTerms);
  if (!terms.size) return [];
  return sentences
    .map((sentence, index) => ({
      text: sentence.text,
      score: sentence.terms.reduce((total, term) => total + Number(terms.has(term)), 0),
      index
    }))
    .filter(sentence => sentence.score > 0)
    .sort((left, right) => right.score - left.score || left.index - right.index)
    .slice(0, limit)
    .map(sentence => sentence.text);
};

export const summarizeStudyNotes = text => {
  const sentences = splitSentences(text);
  if (sentences.length < 2) {
    throw new Error("Teks PDF terlalu sedikit untuk dibuat rangkuman. Pastikan PDF memiliki lapisan teks, bukan hasil scan gambar.");
  }

  const documentFrequency = new Map();
  const termFrequency = new Map();
  const sentenceTerms = sentences.map(sentence => {
    const terms = studyTerms(sentence);
    const seen = new Set(terms);
    for (const term of terms) termFrequency.set(term, (termFrequency.get(term) || 0) + 1);
    for (const term of seen) documentFrequency.set(term, (documentFrequency.get(term) || 0) + 1);
    return terms;
  });

  const rankedSentences = sentences.map((sentence, index) => {
    const terms = sentenceTerms[index];
    const score = terms.reduce((total, term) => {
      const frequency = termFrequency.get(term) || 0;
      const documentCount = documentFrequency.get(term) || 0;
      return total + Math.log1p(frequency) * Math.log1p(sentences.length / documentCount);
    }, 0) / Math.sqrt(terms.length);
    return { sentence, score, index };
  });
  const bullets = rankedSentences
    .sort((left, right) => right.score - left.score)
    .slice(0, Math.min(8, Math.max(4, Math.ceil(sentences.length * 0.14))))
    .sort((left, right) => left.index - right.index)
    .map(item => item.sentence);

  const concepts = [...termFrequency.entries()]
    .filter(([term]) => term.length >= 4)
    .sort((left, right) => right[1] - left[1] || left[0].localeCompare(right[0], "id"))
    .slice(0, 8)
    .map(([term]) => term);

  return {
    bullets,
    concepts,
    questions: concepts.slice(0, 5).map(concept => `Jelaskan pengertian ${concept} dan berikan contoh penerapannya.`)
  };
};

export const rankStudySentences = (text, query, limit = 4) => {
  const terms = [...new Set(studyTerms(query))];
  if (!terms.length) return [];
  return splitSentences(text)
    .map((sentence, index) => {
      const sentenceTerms = new Set(studyTerms(sentence));
      const score = terms.reduce((total, term) => total + (sentenceTerms.has(term) ? 1 : 0), 0);
      return { sentence, score, index };
    })
    .filter(item => item.score > 0)
    .sort((left, right) => right.score - left.score || left.index - right.index)
    .slice(0, limit)
    .map(item => item.sentence);
};

export const extractPdfText = async file => {
  if (!file || file.size === 0 || file.size > 15 * 1024 * 1024) {
    throw new Error("Pilih PDF berukuran maksimal 15 MB.");
  }

  const bytes = new Uint8Array(await file.arrayBuffer());
  const signature = new TextDecoder().decode(bytes.subarray(0, 5));
  if (signature !== "%PDF-") throw new Error("File yang dipilih bukan PDF yang valid.");

  const pdfjs = await import("https://cdn.jsdelivr.net/npm/pdfjs-dist@4.10.38/build/pdf.min.mjs");
  pdfjs.GlobalWorkerOptions.workerSrc = "https://cdn.jsdelivr.net/npm/pdfjs-dist@4.10.38/build/pdf.worker.min.mjs";
  const document = await pdfjs.getDocument({ data: bytes }).promise;
  try {
    if (document.numPages > 500) throw new Error("PDF maksimal 500 halaman.");
    const pages = [];
    let totalLength = 0;
    for (let pageNumber = 1; pageNumber <= document.numPages; pageNumber++) {
      const page = await document.getPage(pageNumber);
      const content = await page.getTextContent();
      const pageText = content.items
        .map(item => "str" in item ? `${item.str}${item.hasEOL ? "\n" : " "}` : "")
        .join("")
        .replace(/[ \t]+/g, " ")
        .replace(/ *\n */g, "\n")
        .trim();
      totalLength += pageText.length;
      if (totalLength > 1_500_000) throw new Error("Teks PDF terlalu panjang untuk diproses di browser (batas 1,5 juta karakter).");
      if (pageText) pages.push(pageText);
    }
    const text = pages.join("\n");
    if (text.length < 100) throw new Error("Teks PDF tidak ditemukan. PDF hasil scan/foto memerlukan OCR, yang belum tersedia.");
    return { text, pages: document.numPages };
  } finally {
    await document.destroy();
  }
};
