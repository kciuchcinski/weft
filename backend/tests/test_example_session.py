import json
import re
import unittest
from pathlib import Path

from app.core.models import FigureData

_REPO = Path(__file__).resolve().parents[2]
_EXAMPLE = _REPO / "frontend" / "public" / "example_session.json"
_STORE = _REPO / "frontend" / "src" / "state" / "store.ts"


def _frontend_session_version() -> int:
    match = re.search(r"export const SESSION_SCHEMA_VERSION = (\d+);", _STORE.read_text())
    if not match:
        raise AssertionError(f"SESSION_SCHEMA_VERSION not found in {_STORE}")
    return int(match.group(1))


class ExampleSessionTests(unittest.TestCase):
    """"Load example" fetches this static file as-is, so a schema change that it
    doesn't follow would break the button without any other test noticing."""

    @classmethod
    def setUpClass(cls) -> None:
        cls.session = json.loads(_EXAMPLE.read_text())

    def test_session_version_matches_frontend(self) -> None:
        self.assertEqual(self.session["schemaVersion"], _frontend_session_version())

    def test_figure_data_matches_backend_model(self) -> None:
        data = FigureData.model_validate(self.session["data"])
        self.assertEqual(data.schemaVersion, FigureData.model_fields["schemaVersion"].default)
        self.assertTrue(data.clusters)

    def test_view_lanes_reference_existing_clusters(self) -> None:
        uids = {c["uid"] for c in self.session["data"]["clusters"]}
        lanes = self.session["view"]["lanes"]
        self.assertTrue(lanes)
        for lane in lanes:
            self.assertTrue(lane)
            self.assertLessEqual(set(lane), uids)


if __name__ == "__main__":
    unittest.main()
