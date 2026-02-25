import os
import logging
from pathlib import Path

from celery import Celery
from python_backend.env_loader import load_python_backend_env


BASE_DIR = Path(__file__).resolve().parent.parent
load_python_backend_env(BASE_DIR)
logger = logging.getLogger(__name__)
CELERY_DATA_DIR = BASE_DIR / ".data" / "celery"
QUEUE_DIR = CELERY_DATA_DIR / "queue"
PROCESSED_DIR = CELERY_DATA_DIR / "processed"
RESULTS_DB = CELERY_DATA_DIR / "results.sqlite3"

for directory in (QUEUE_DIR, PROCESSED_DIR):
    directory.mkdir(parents=True, exist_ok=True)


def _default_broker() -> str:
    return os.getenv("CELERY_BROKER_URL", "filesystem://")


def _default_result_backend() -> str:
    return os.getenv("CELERY_RESULT_BACKEND", f"db+sqlite:///{RESULTS_DB}")


broker_url = _default_broker()
result_backend = _default_result_backend()
logger.info(
    "python backend env loaded llm=%s deepseek_key_present=%s anthropic_key_present=%s",
    (os.getenv("LLM_PROVIDER") or os.getenv("LLM") or "(unset)"),
    bool(os.getenv("DEEPSEEK_API_KEY") or os.getenv("DEEPSEEK")),
    bool(os.getenv("ANTHROPIC_API_KEY") or os.getenv("ANTHROPIC")),
)

celery_app = Celery(
  "vector_python_backend",
  broker=broker_url,
  backend=result_backend,
  include=["python_backend.llm_tasks"],
)

celery_app.conf.update(
  task_track_started=True,
  task_serializer="json",
  result_serializer="json",
  accept_content=["json"],
  timezone="UTC",
  enable_utc=True,
  broker_transport_options={
      # Filesystem transport requires producer/consumer paths to intersect.
      # Using a shared queue directory avoids dead-lettered PENDING tasks
      # when Flask and worker run with identical settings on one machine.
      "data_folder_in": str(QUEUE_DIR),
      "data_folder_out": str(QUEUE_DIR),
      "data_folder_processed": str(PROCESSED_DIR),
  },
)
