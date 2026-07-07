"""memory.py — local vector store for task memory.

Uses sentence-transformers + SQLite. Optional dependency — if
sentence-transformers is not installed, memory is silently disabled.

At <10K memories, brute-force cosine in NumPy is <1ms. No FAISS/hnswlib
needed until that changes.
"""
from __future__ import annotations

import json
import logging
import sqlite3
import time
from dataclasses import dataclass
from pathlib import Path
from typing import Any

log = logging.getLogger(__name__)

_DB_PATH = Path.home() / ".callisto" / "memory.db"
_EMBEDDING_MODEL = "sentence-transformers/all-MiniLM-L6-v2"
_EMBEDDING_DIM = 384


@dataclass
class Memory:
    """A single retrieved memory."""

    task: str
    summary: str
    pages: list[str]
    similarity: float
    created_at: str


class MemoryStore:
    """
    Local vector store backed by SQLite.

    Usage::

        store = MemoryStore()
        store.store("Find pricing page", "Found it at /pricing", ["https://x.com"])

        memories = store.retrieve("Find the pricing page for linear.app", k=3)
        for m in memories:
            print(m.task, m.similarity)
    """

    def __init__(self, db_path: Path | str | None = None) -> None:
        self._db_path = Path(db_path) if db_path else _DB_PATH
        self._model: Any = None
        self._available = self._check_available()

        if self._available:
            self._init_db()

    @property
    def available(self) -> bool:
        return self._available

    def _check_available(self) -> bool:
        try:
            import numpy  # noqa: F401
            import sentence_transformers  # noqa: F401
            return True
        except ImportError:
            log.info(
                "sentence-transformers or numpy not installed. "
                "Memory is disabled. Install with: "
                "pip install callisto-harness[memory]"
            )
            return False

    def _init_db(self) -> None:
        self._db_path.parent.mkdir(parents=True, exist_ok=True)
        with sqlite3.connect(str(self._db_path)) as conn:
            conn.execute("""
                CREATE TABLE IF NOT EXISTS memories (
                    id INTEGER PRIMARY KEY AUTOINCREMENT,
                    task TEXT NOT NULL,
                    summary TEXT NOT NULL,
                    pages TEXT,
                    created_at TEXT NOT NULL,
                    embedding BLOB NOT NULL
                )
            """)
            conn.commit()

    def _get_model(self) -> Any:
        """Load the embedding model lazily (first call only)."""
        if self._model is None:
            from sentence_transformers import SentenceTransformer
            log.info("loading embedding model: %s", _EMBEDDING_MODEL)
            self._model = SentenceTransformer(_EMBEDDING_MODEL)
        return self._model

    def _embed(self, text: str) -> bytes:
        """Embed text and return as bytes (float32)."""
        import numpy as np
        model = self._get_model()
        vec = model.encode(text, normalize_embeddings=True)
        return np.array(vec, dtype=np.float32).tobytes()

    def store(
        self,
        task: str,
        summary: str,
        pages: list[str] | None = None,
    ) -> None:
        """
        Embed and store a task memory.

        Called at task end on success.
        """
        if not self._available:
            return

        embedding = self._embed(task + " " + summary)
        created_at = time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime())
        pages_json = json.dumps(pages or [])

        with sqlite3.connect(str(self._db_path)) as conn:
            conn.execute(
                "INSERT INTO memories (task, summary, pages, created_at, embedding) "
                "VALUES (?, ?, ?, ?, ?)",
                (task, summary, pages_json, created_at, embedding),
            )
            conn.commit()

        log.info("stored memory for task: %s", task[:80])

    def retrieve(self, query: str, k: int = 3) -> list[Memory]:
        """
        Find the top-K most similar past memories by cosine similarity.

        Returns an empty list if memory is disabled or no memories exist.
        """
        if not self._available:
            return []

        import numpy as np

        query_vec = np.frombuffer(self._embed(query), dtype=np.float32)

        with sqlite3.connect(str(self._db_path)) as conn:
            rows = conn.execute(
                "SELECT task, summary, pages, created_at, embedding FROM memories"
            ).fetchall()

        if not rows:
            return []

        # Brute-force cosine similarity (vectors are already L2-normalised)
        memories: list[tuple[float, Memory]] = []
        for task, summary, pages_json, created_at, emb_blob in rows:
            stored_vec = np.frombuffer(emb_blob, dtype=np.float32)
            similarity = float(np.dot(query_vec, stored_vec))
            memories.append((
                similarity,
                Memory(
                    task=task,
                    summary=summary,
                    pages=json.loads(pages_json) if pages_json else [],
                    similarity=similarity,
                    created_at=created_at,
                ),
            ))

        # Sort by similarity descending, take top-K
        memories.sort(key=lambda x: x[0], reverse=True)
        return [m for _, m in memories[:k]]

    def format_for_context(
        self, memories: list[Memory], max_chars: int = 8000
    ) -> str:
        """
        Format retrieved memories as a context string for the model.

        Token-budget capped at ~2K tokens (8000 chars).
        """
        if not memories:
            return ""

        lines = ["## Relevant past experience\n"]
        used = len(lines[0])

        for m in memories:
            entry = (
                f"- **Task:** {m.task}\n"
                f"  **Result:** {m.summary}\n"
                f"  **Similarity:** {m.similarity:.2f}\n\n"
            )
            if used + len(entry) > max_chars:
                break
            lines.append(entry)
            used += len(entry)

        return "".join(lines)
