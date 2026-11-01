# The smallest Rudder app: a panel with one line of text and a button that counts clicks.
# Start bridge.py first, then run this and open Rudder's popup.
import grpc
import rudder_pb2 as pb, rudder_pb2_grpc as rpc

rudder = rpc.RudderStub(grpc.insecure_channel("127.0.0.1:7833"))


def show(clicks):
    rudder.SetPanel(pb.Panel(id="hello", title="Hello", blocks=[
        pb.Block(text=f"Clicked {clicks} times"),
        pb.Block(button="Click me"),
    ]))


show(0)
for n, click in enumerate(rudder.PanelEvents(pb.Empty()), 1):
    show(n)
