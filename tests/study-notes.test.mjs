import test from "node:test";
import assert from "node:assert/strict";

import {
  createPdfSearchEntry,
  createSearchIndex,
  normalizeStudyText,
  rankIndexedSentences,
  rankStudySentences,
  studyTerms,
  summarizeStudyNotes
} from "../study-notes.mjs";

const sampleText = [
  "Manajemen adalah proses perencanaan, pengorganisasian, pengarahan, dan pengendalian sumber daya organisasi untuk mencapai tujuan secara efektif dan efisien.",
  "Perencanaan menetapkan tujuan organisasi serta langkah kerja yang diperlukan untuk mencapai sasaran tersebut.",
  "Pengorganisasian membagi pekerjaan, wewenang, dan tanggung jawab agar setiap anggota memahami perannya.",
  "Pengarahan membantu anggota bekerja sama melalui komunikasi, kepemimpinan, dan motivasi yang sesuai.",
  "Pengendalian membandingkan hasil kerja dengan standar, menemukan penyimpangan, dan menentukan tindakan perbaikan.",
  "Efektivitas menunjukkan tingkat keberhasilan pencapaian tujuan, sedangkan efisiensi menunjukkan penggunaan sumber daya secara hemat.",
  "Keempat fungsi manajemen saling berhubungan dan dijalankan secara berulang sesuai perubahan kondisi organisasi."
].join(" ");

test("normalizes Indonesian text and filters common terms", () => {
  assert.equal(normalizeStudyText("Efisiensi Organisasi"), "efisiensi organisasi");
  assert.deepEqual(studyTerms("Perencanaan dan pengorganisasian"), ["perencanaan", "pengorganisasian"]);
});

test("creates exam notes with key points, concepts, and practice questions", () => {
  const notes = summarizeStudyNotes(sampleText);
  assert.ok(notes.bullets.length >= 4);
  assert.ok(notes.bullets.length <= 8);
  assert.ok(notes.bullets.some(sentence => sentence.includes("pengendalian")));
  assert.ok(notes.concepts.includes("organisasi"));
  assert.ok(notes.questions.some(question => question.includes("organisasi")));
});

test("rejects text that cannot support a useful summary", () => {
  assert.throws(
    () => summarizeStudyNotes("Halaman PDF kosong."),
    /Teks PDF terlalu sedikit/
  );
});

test("ranks relevant text excerpts by matching question terms", () => {
  const excerpts = rankStudySentences(sampleText, "apa fungsi pengendalian dalam manajemen?", 2);
  assert.equal(excerpts.length, 2);
  assert.match(excerpts[0], /pengendalian/i);
});

test("returns no excerpts when the question has no matching terms", () => {
  assert.deepEqual(rankStudySentences(sampleText, "astronomi galaksi", 3), []);
});

test("builds a compact searchable index from course material", () => {
  const index = createSearchIndex({
    title: "Fungsi Manajemen",
    courseName: "Pengantar Manajemen",
    text: sampleText,
    concepts: ["perencanaan", "pengendalian"]
  });

  assert.ok(index.terms.includes("pengendalian"));
  assert.ok(index.sentences.length > 0);
  const excerpts = rankIndexedSentences(index.sentences, new Set(["pengendalian", "standar"]), 1);
  assert.match(excerpts[0], /^Pengendalian membandingkan hasil kerja/);
});

test("stores a searchable PDF summary without copying the full extracted text", () => {
  const summary = summarizeStudyNotes(sampleText);
  const indexed = createPdfSearchEntry({
    id: "pdf-1",
    courseId: "manajemen",
    courseName: "Pengantar Manajemen",
    filename: "materi.pdf",
    uploadedAt: 1,
    pages: 2,
    text: `${sampleText} ${"teks tambahan ".repeat(1000)}`,
    summary
  });

  assert.equal(indexed.id, "pdf-1");
  assert.ok(indexed.terms.includes("pengendalian"));
  assert.equal("text" in indexed, false);
  assert.ok(indexed.sentences.length > 0);
  const excerpts = rankIndexedSentences(indexed.sentences, new Set(["pengendalian"]), 2);
  assert.ok(excerpts.some(sentence => studyTerms(sentence).includes("pengendalian")));
  assert.ok(excerpts.every(sentence => summary.bullets.includes(sentence)));
});
