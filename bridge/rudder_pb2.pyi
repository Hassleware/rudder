from google.protobuf.internal import containers as _containers
from google.protobuf import descriptor as _descriptor
from google.protobuf import message as _message
from collections.abc import Iterable as _Iterable, Mapping as _Mapping
from typing import ClassVar as _ClassVar, Optional as _Optional, Union as _Union

DESCRIPTOR: _descriptor.FileDescriptor

class Empty(_message.Message):
    __slots__ = ()
    def __init__(self) -> None: ...

class Filters(_message.Message):
    __slots__ = ("filters",)
    FILTERS_FIELD_NUMBER: _ClassVar[int]
    filters: _containers.RepeatedScalarFieldContainer[str]
    def __init__(self, filters: _Optional[_Iterable[str]] = ...) -> None: ...

class Stats(_message.Message):
    __slots__ = ("checked", "hidden", "hidden_by_filter", "likes", "dislikes", "learning")
    class HiddenByFilterEntry(_message.Message):
        __slots__ = ("key", "value")
        KEY_FIELD_NUMBER: _ClassVar[int]
        VALUE_FIELD_NUMBER: _ClassVar[int]
        key: str
        value: int
        def __init__(self, key: _Optional[str] = ..., value: _Optional[int] = ...) -> None: ...
    CHECKED_FIELD_NUMBER: _ClassVar[int]
    HIDDEN_FIELD_NUMBER: _ClassVar[int]
    HIDDEN_BY_FILTER_FIELD_NUMBER: _ClassVar[int]
    LIKES_FIELD_NUMBER: _ClassVar[int]
    DISLIKES_FIELD_NUMBER: _ClassVar[int]
    LEARNING_FIELD_NUMBER: _ClassVar[int]
    checked: int
    hidden: int
    hidden_by_filter: _containers.ScalarMap[str, int]
    likes: int
    dislikes: int
    learning: bool
    def __init__(self, checked: _Optional[int] = ..., hidden: _Optional[int] = ..., hidden_by_filter: _Optional[_Mapping[str, int]] = ..., likes: _Optional[int] = ..., dislikes: _Optional[int] = ..., learning: _Optional[bool] = ...) -> None: ...

class Hidden(_message.Message):
    __slots__ = ("id", "title", "channel", "why")
    ID_FIELD_NUMBER: _ClassVar[int]
    TITLE_FIELD_NUMBER: _ClassVar[int]
    CHANNEL_FIELD_NUMBER: _ClassVar[int]
    WHY_FIELD_NUMBER: _ClassVar[int]
    id: str
    title: str
    channel: str
    why: str
    def __init__(self, id: _Optional[str] = ..., title: _Optional[str] = ..., channel: _Optional[str] = ..., why: _Optional[str] = ...) -> None: ...

class State(_message.Message):
    __slots__ = ("connected", "enabled", "filters", "layers", "stats", "recent")
    CONNECTED_FIELD_NUMBER: _ClassVar[int]
    ENABLED_FIELD_NUMBER: _ClassVar[int]
    FILTERS_FIELD_NUMBER: _ClassVar[int]
    LAYERS_FIELD_NUMBER: _ClassVar[int]
    STATS_FIELD_NUMBER: _ClassVar[int]
    RECENT_FIELD_NUMBER: _ClassVar[int]
    connected: bool
    enabled: bool
    filters: _containers.RepeatedScalarFieldContainer[str]
    layers: _containers.RepeatedScalarFieldContainer[str]
    stats: Stats
    recent: _containers.RepeatedCompositeFieldContainer[Hidden]
    def __init__(self, connected: _Optional[bool] = ..., enabled: _Optional[bool] = ..., filters: _Optional[_Iterable[str]] = ..., layers: _Optional[_Iterable[str]] = ..., stats: _Optional[_Union[Stats, _Mapping]] = ..., recent: _Optional[_Iterable[_Union[Hidden, _Mapping]]] = ...) -> None: ...

class Video(_message.Message):
    __slots__ = ("id", "title", "channel", "image", "image_type")
    ID_FIELD_NUMBER: _ClassVar[int]
    TITLE_FIELD_NUMBER: _ClassVar[int]
    CHANNEL_FIELD_NUMBER: _ClassVar[int]
    IMAGE_FIELD_NUMBER: _ClassVar[int]
    IMAGE_TYPE_FIELD_NUMBER: _ClassVar[int]
    id: str
    title: str
    channel: str
    image: bytes
    image_type: str
    def __init__(self, id: _Optional[str] = ..., title: _Optional[str] = ..., channel: _Optional[str] = ..., image: _Optional[bytes] = ..., image_type: _Optional[str] = ...) -> None: ...

class JudgeRequest(_message.Message):
    __slots__ = ("id", "videos")
    ID_FIELD_NUMBER: _ClassVar[int]
    VIDEOS_FIELD_NUMBER: _ClassVar[int]
    id: int
    videos: _containers.RepeatedCompositeFieldContainer[Video]
    def __init__(self, id: _Optional[int] = ..., videos: _Optional[_Iterable[_Union[Video, _Mapping]]] = ...) -> None: ...

class Verdict(_message.Message):
    __slots__ = ("blocked", "why")
    BLOCKED_FIELD_NUMBER: _ClassVar[int]
    WHY_FIELD_NUMBER: _ClassVar[int]
    blocked: bool
    why: str
    def __init__(self, blocked: _Optional[bool] = ..., why: _Optional[str] = ...) -> None: ...

class Verdicts(_message.Message):
    __slots__ = ("id", "results")
    ID_FIELD_NUMBER: _ClassVar[int]
    RESULTS_FIELD_NUMBER: _ClassVar[int]
    id: int
    results: _containers.RepeatedCompositeFieldContainer[Verdict]
    def __init__(self, id: _Optional[int] = ..., results: _Optional[_Iterable[_Union[Verdict, _Mapping]]] = ...) -> None: ...

class LayerHello(_message.Message):
    __slots__ = ("name",)
    NAME_FIELD_NUMBER: _ClassVar[int]
    name: str
    def __init__(self, name: _Optional[str] = ...) -> None: ...

class LayerMessage(_message.Message):
    __slots__ = ("hello", "verdicts")
    HELLO_FIELD_NUMBER: _ClassVar[int]
    VERDICTS_FIELD_NUMBER: _ClassVar[int]
    hello: LayerHello
    verdicts: Verdicts
    def __init__(self, hello: _Optional[_Union[LayerHello, _Mapping]] = ..., verdicts: _Optional[_Union[Verdicts, _Mapping]] = ...) -> None: ...
