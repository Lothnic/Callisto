from callisto_eval.agents import CallistoAgent, FakeAgent, goto_eval_code
from callisto_eval.types import EvalTask


def test_fake_agent_returns_expected_answer():
    task = EvalTask(
        id="t1",
        benchmark="fake",
        site=None,
        start_url="https://example.com",
        instruction="find heading",
        expected="Example Domain",
    )

    result = FakeAgent().run(task)

    assert result.final_answer == "Example Domain"
    assert result.status == "pass"


def test_callisto_agent_records_provider_and_model():
    agent = CallistoAgent(provider="siliconflow", model="tencent/Hy3", headless=False)

    assert agent.provider == "siliconflow"
    assert agent.model == "tencent/Hy3"
    assert agent.name == "siliconflow/tencent/Hy3"
    assert agent.headless is False


def test_goto_eval_code_json_escapes_quotes_and_control_chars():
    code = goto_eval_code("https://example.com/path?q=it's")
    assert code == 'await page.goto("https://example.com/path?q=it\'s")'
    # A single-quoted f-string interpolation would have broken on the apostrophe.
    assert "page.goto('https://" not in code

    nasty = goto_eval_code('https://x.test/"); alert(1)//')
    assert nasty == 'await page.goto("https://x.test/\\"); alert(1)//")'
