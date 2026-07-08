from callisto_eval.agents import CallistoAgent, FakeAgent
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
