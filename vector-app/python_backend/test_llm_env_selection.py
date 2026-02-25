import os
import unittest
from unittest.mock import Mock, patch

from python_backend.llm_tasks import (
    ANTHROPIC_ENDPOINT,
    DEEPSEEK_ENDPOINT,
    _invoke_provider,
    _resolve_provider,
)


class LlmEnvSelectionTests(unittest.TestCase):
    @staticmethod
    def _load_local_env_file() -> None:
        env_path = os.path.join(os.getcwd(), ".env.local")
        if not os.path.exists(env_path):
            return
        with open(env_path, "r", encoding="utf-8") as handle:
            for raw_line in handle:
                line = raw_line.strip()
                if not line or line.startswith("#") or "=" not in line:
                    continue
                key, value = line.split("=", 1)
                key = key.strip()
                value = value.strip().strip('"').strip("'")
                if key and key not in os.environ:
                    os.environ[key] = value

    def test_llm_deepseek_uses_deepseek_api_key_and_endpoint(self):
        with patch.dict(
            os.environ,
            {
                "LLM": "deepseek",
                "DEEPSEEK_API_KEY": "deepseek_key_from_env",
                "ANTHROPIC_API_KEY": "anthropic_key_from_env",
            },
            clear=True,
        ):
            mock_response = Mock()
            mock_response.json.return_value = {
                "choices": [{"message": {"content": "deepseek ok"}}]
            }
            mock_response.raise_for_status.return_value = None

            with patch("python_backend.llm_tasks.requests.post", return_value=mock_response) as post:
                provider = _resolve_provider()
                result = _invoke_provider(prompt="hello", provider=provider)

                self.assertEqual(provider, "deepseek")
                self.assertEqual(result, "deepseek ok")
                post.assert_called_once()

                called_url = post.call_args.args[0]
                called_headers = post.call_args.kwargs["headers"]
                self.assertEqual(called_url, DEEPSEEK_ENDPOINT)
                self.assertEqual(called_headers["Authorization"], "Bearer deepseek_key_from_env")

    def test_llm_anthropic_uses_anthropic_api_key_and_endpoint(self):
        with patch.dict(
            os.environ,
            {
                "LLM": "anthropic",
                "DEEPSEEK_API_KEY": "deepseek_key_from_env",
                "ANTHROPIC_API_KEY": "anthropic_key_from_env",
            },
            clear=True,
        ):
            mock_response = Mock()
            mock_response.json.return_value = {
                "content": [{"text": "anthropic ok"}]
            }
            mock_response.raise_for_status.return_value = None

            with patch("python_backend.llm_tasks.requests.post", return_value=mock_response) as post:
                provider = _resolve_provider()
                result = _invoke_provider(prompt="hello", provider=provider)

                self.assertEqual(provider, "anthropic")
                self.assertEqual(result, "anthropic ok")
                post.assert_called_once()

                called_url = post.call_args.args[0]
                called_headers = post.call_args.kwargs["headers"]
                self.assertEqual(called_url, ANTHROPIC_ENDPOINT)
                self.assertEqual(called_headers["x-api-key"], "anthropic_key_from_env")

    def test_live_llm_call_uses_selected_provider_credentials(self):
        self._load_local_env_file()
        if os.getenv("RUN_LIVE_LLM_TEST") != "1":
            self.skipTest("Set RUN_LIVE_LLM_TEST=1 to run real provider call")

        prompt = "Reply with exactly VECTOR_LIVE_OK"

        # Test DeepSeek
        with self.subTest(provider="deepseek"):
            if os.getenv("DEEPSEEK_API_KEY") or os.getenv("DEEPSEEK"):
                content = _invoke_provider(prompt=prompt, provider="deepseek")
                self.assertIsInstance(content, str)
                self.assertTrue(content.strip(), "Live DeepSeek provider returned empty content")
                self.assertIn("VECTOR_LIVE_OK", content.upper())
            else:
                self.skipTest("Missing DEEPSEEK_API_KEY or DEEPSEEK for live DeepSeek call")

        # Test Anthropic
        with self.subTest(provider="anthropic"):
            if os.getenv("ANTHROPIC_API_KEY") or os.getenv("ANTHROPIC"):
                content = _invoke_provider(prompt=prompt, provider="anthropic")
                self.assertIsInstance(content, str)
                self.assertTrue(content.strip(), "Live Anthropic provider returned empty content")
                self.assertIn("VECTOR_LIVE_OK", content.upper())
            else:
                self.skipTest("Missing ANTHROPIC_API_KEY or ANTHROPIC for live Anthropic call")


if __name__ == "__main__":
    unittest.main()
