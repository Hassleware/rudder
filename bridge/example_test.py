# Your own tests of Rudder, against your real filters and layers. Needs bridge.py running and Firefox open.
# Run: python -m unittest example_test   (edit the titles to match your filters)
import unittest
import grpc
import rudder_pb2 as pb, rudder_pb2_grpc as rpc

rudder = rpc.RudderStub(grpc.insecure_channel("127.0.0.1:7833"))


def check(title, channel=""):
    return rudder.Test(pb.TestRequest(videos=[pb.Video(title=title, channel=channel)])).results[0]


class Filters(unittest.TestCase):
    def test_gaming_hidden(self):
        r = check("Minecraft hardcore: 100 days")
        self.assertTrue(r.hidden, r.why)

    def test_baking_shown(self):
        r = check("Easy sourdough bread at home", "Baking with Jo")
        self.assertFalse(r.hidden, r.why)

    def test_which_filter(self):
        r = check("Breaking news: election results")
        self.assertTrue(any(v.blocked for k, v in r.filters.items() if k.startswith("news")), dict(r.filters))


class Speed(unittest.TestCase):
    def test_keywords_fast(self):
        t = {x.name: x for x in rudder.GetTimings(pb.TimingsRequest()).timings}
        if "keywords (a video)" not in t:
            self.skipTest("no videos checked yet: open YouTube first")
        self.assertLess(t["keywords (a video)"].p95_ms, 5)


if __name__ == "__main__":
    unittest.main()
