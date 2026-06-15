const pdf = require("pdf-parse");
const multer = require("multer");
const mongoose = require("mongoose");

const Document = require("../models/document.model");
const DocumentChunk = require("../models/documentChunk.model");
const SystemSettings = require("../models/systemSettings.model");

const { processDocument, queryDocuments } = require("../services/documentService");
const { runLLM } = require("../agents/llmAdapter");

const upload = multer({ storage: multer.memoryStorage() });
const MAX_SELECTED_DOCUMENTS = 10;
const MAX_RAG_CONTEXT_CHARS = 12000;

/* -----------------------------
   Upload Document
----------------------------- */

async function uploadDocument(req, res) {
  try {

    const file = req.file;

    if (!file) {
      return res.status(400).json({
        ok: false,
        error: "file_required"
      });
    }

    const extension = file.originalname.split(".").pop().toLowerCase();

    let text = "";

    /* ---------- PDF ---------- */
    if (extension === "pdf") {

      const pdfData = await pdf(file.buffer);
      text = pdfData.text || "";

    }

    /* ---------- TEXT / MARKDOWN ---------- */
    else if (extension === "txt" || extension === "md") {

      text = file.buffer.toString("utf-8");

    }

    /* ---------- JSON ---------- */
    else if (extension === "json") {

      const json = JSON.parse(file.buffer.toString("utf-8"));
      text = JSON.stringify(json, null, 2);

    }

    /* ---------- CSV ---------- */
    else if (extension === "csv") {

      text = file.buffer.toString("utf-8");

    }

    /* ---------- UNSUPPORTED ---------- */
    else {

      return res.status(400).json({
        ok: false,
        error: "unsupported_file_type"
      });

    }

    if (!text.trim()) {
      return res.status(400).json({
        ok: false,
        error: "empty_document"
      });
    }

    /* ---------- Create document record ---------- */

    const document = await Document.create({
      userId: req.user._id,
      title: file.originalname,
      fileType: extension,
      size: file.size
    });

    /* ---------- Process document (chunk + embed) ---------- */

    const settings = await SystemSettings.findOne({
      userId: req.user._id,
    });

    const chatSettings = settings?.documentChat || {};

    const provider = chatSettings.provider || "ollama";
    const model = chatSettings.model || "gemma3:4b";
    const topK = chatSettings.topK || 3;
    const temperature = chatSettings.temperature ?? 0.2;

    const agent = { config: { provider } };

    await processDocument(agent, document, text);

    res.json({
      ok: true,
      document
    });

  } catch (err) {

    console.error("Document upload error:", err);

    res.status(500).json({
      ok: false,
      error: "upload_failed"
    });

  }
}

/* -----------------------------
   List Documents
----------------------------- */

async function listDocuments(req, res) {

  const docs = await Document.find({
    userId: req.user._id
  }).sort({ createdAt: -1 });

  res.json({
    ok: true,
    documents: docs
  });

}

/* -----------------------------
   Document Chat (RAG)
----------------------------- */

async function chatWithDocument(req, res) {
  try {

    const { documentId, documentIds, question } = req.body;

    if (typeof question !== "string" || !question.trim()) {
      return res.status(400).json({
        ok: false,
        error: "question_required",
      });
    }

    const requestedDocumentIds = Array.isArray(documentIds)
      ? documentIds
      : [documentId];

    const selectedDocumentIds = [...new Set(
      requestedDocumentIds
        .filter(Boolean)
        .map((id) => id.toString())
    )];

    if (!selectedDocumentIds.length) {
      return res.status(400).json({
        ok: false,
        error: "document_required",
      });
    }

    if (selectedDocumentIds.length > MAX_SELECTED_DOCUMENTS) {
      return res.status(400).json({
        ok: false,
        error: "too_many_documents",
      });
    }

    const hasInvalidDocumentId = selectedDocumentIds.some(
      (id) => !mongoose.Types.ObjectId.isValid(id)
    );

    if (hasInvalidDocumentId) {
      return res.status(400).json({
        ok: false,
        error: "invalid_document_id",
      });
    }

    const documents = await Document.find({
      _id: { $in: selectedDocumentIds },
      userId: req.user._id
    }).lean();

    if (documents.length !== selectedDocumentIds.length) {
      return res.status(404).json({
        ok: false,
        error: "Document not found"
      });
    }

    const hasNonReadyDocument = documents.some((document) => document.status !== "ready");

    if (hasNonReadyDocument) {
      return res.status(400).json({
        ok: false,
        error: "document_not_ready"
      });
    }

    const trimmedQuestion = question.trim();
    const documentTitleById = new Map(
      documents.map((document) => [
        document._id.toString(),
        document.title || document.name || "Untitled document"
      ])
    );

    /* ---------- Load user settings ---------- */

    const settings = await SystemSettings.findOne({
      userId: req.user._id,
    });

    const chatSettings = settings?.documentChat || {};

    const provider = chatSettings.provider || "ollama";
    const model = chatSettings.model || "gemma3:4b";
    const topK = chatSettings.topK || 3;
    const temperature = chatSettings.temperature ?? 0.2;

    const agent = { config: { provider } };

    /* ---------- Query vector store ---------- */

    const chunks = await queryDocuments(
      agent,
      req.user._id,
      selectedDocumentIds,
      trimmedQuestion,
      topK
    );

    if (!chunks.length) {
      return res.json({
        ok: true,
        answer: "I could not find relevant information in the selected document(s).",
        sources: [],
        documentIds: selectedDocumentIds
      });
    }

    const enrichedChunks = chunks.map((chunk) => {
      const chunkDocumentId = chunk.documentId.toString();

      return {
        documentId: chunkDocumentId,
        title: documentTitleById.get(chunkDocumentId) || "Untitled document",
        chunkIndex: chunk.chunkIndex,
        score: chunk.score,
        content: chunk.content
      };
    });

    const contextBlocks = [];
    const includedChunks = [];
    let contextLength = 0;

    for (const chunk of enrichedChunks) {
      const separator = contextBlocks.length ? "\n\n---\n\n" : "";
      const header = `[${chunk.title}]
Chunk ${chunk.chunkIndex}
`;
      let content = chunk.content || "";
      let block = `${header}${content}`;
      let nextLength = contextLength + separator.length + block.length;

      if (nextLength > MAX_RAG_CONTEXT_CHARS) {
        if (contextBlocks.length > 0) {
          break;
        }

        // If the top chunk alone is too large, include a truncated version within the context budget.
        const availableContentLength = Math.max(
          MAX_RAG_CONTEXT_CHARS - separator.length - header.length,
          0
        );

        content = content.slice(0, availableContentLength).trim();
        block = `${header}${content}`;
        nextLength = contextLength + separator.length + block.length;
      }

      contextBlocks.push(`${separator}${block}`);
      includedChunks.push({
        ...chunk,
        content
      });
      contextLength = nextLength;
    }

    const context = contextBlocks.join("");

    const seenSources = new Set();
    const sources = includedChunks
      .filter((chunk) => {
        const sourceKey = `${chunk.documentId}:${chunk.chunkIndex}`;

        if (seenSources.has(sourceKey)) {
          return false;
        }

        seenSources.add(sourceKey);
        return true;
      })
      .map((chunk) => ({
        documentId: chunk.documentId,
        title: chunk.title,
        chunkIndex: chunk.chunkIndex,
        score: typeof chunk.score === "number"
          ? Number(chunk.score.toFixed(4))
          : chunk.score
      }));

    const prompt = `
You are analyzing one or more selected documents using only the provided context.

Answer only from the context. If the answer is not present, say you could not find the information in the selected document(s).

When multiple documents are relevant, synthesize across them and use document names naturally when comparing or attributing claims.

Do not invent information or rely on knowledge outside the context.

The context may contain structured data such as CSV rows or tables.

Each line may represent an entry such as:
Name, Role, Company

Extract information carefully from the rows.

If the question asks for a list, extract all matching rows from the provided context.

CONTEXT:
${context}

QUESTION:
${trimmedQuestion}
`;

    /* ---------- Run LLM ---------- */

    const llm = await runLLM(prompt, {
      provider,
      model,
      temperature,
    });

    res.json({
      ok: true,
      answer: llm.text,
      sources,
      documentIds: selectedDocumentIds
    });

  } catch (err) {

    console.error("Document query error:", err);

    res.status(500).json({
      ok: false,
      error: "query_failed",
    });

  }
}

/* -----------------------------
   Delete Document
----------------------------- */

async function deleteDocument(req, res) {

  try {

    const { id } = req.params;

    await Document.deleteOne({
      _id: id,
      userId: req.user._id
    });

    await DocumentChunk.deleteMany({
      documentId: id,
      userId: req.user._id
    });

    res.json({ ok: true });

  } catch (err) {

    console.error("Delete document error:", err);

    res.status(500).json({ ok: false });

  }

}

/* -----------------------------
   Get Single Document
----------------------------- */

async function getDocument(req, res) {

  try {

    const { id } = req.params;

    const document = await Document.findById(id).lean();

    if (!document) {

      return res.status(404).json({
        ok: false,
        error: "Document not found"
      });

    }

    res.json({
      ok: true,
      document
    });

  } catch (err) {

    console.error("Get document error:", err);

    res.status(500).json({
      ok: false,
      error: "fetch_failed"
    });

  }

}

/* ----------------------------- */

module.exports = {
  upload,
  uploadDocument,
  listDocuments,
  getDocument,
  chatWithDocument,
  deleteDocument
};
