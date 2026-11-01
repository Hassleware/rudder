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

class Panel(_message.Message):
    __slots__ = ("id", "title", "blocks")
    ID_FIELD_NUMBER: _ClassVar[int]
    TITLE_FIELD_NUMBER: _ClassVar[int]
    BLOCKS_FIELD_NUMBER: _ClassVar[int]
    id: str
    title: str
    blocks: _containers.RepeatedCompositeFieldContainer[Block]
    def __init__(self, id: _Optional[str] = ..., title: _Optional[str] = ..., blocks: _Optional[_Iterable[_Union[Block, _Mapping]]] = ...) -> None: ...

class Block(_message.Message):
    __slots__ = ("text", "stats", "bars", "table", "button")
    TEXT_FIELD_NUMBER: _ClassVar[int]
    STATS_FIELD_NUMBER: _ClassVar[int]
    BARS_FIELD_NUMBER: _ClassVar[int]
    TABLE_FIELD_NUMBER: _ClassVar[int]
    BUTTON_FIELD_NUMBER: _ClassVar[int]
    text: str
    stats: StatGrid
    bars: BarList
    table: Table
    button: str
    def __init__(self, text: _Optional[str] = ..., stats: _Optional[_Union[StatGrid, _Mapping]] = ..., bars: _Optional[_Union[BarList, _Mapping]] = ..., table: _Optional[_Union[Table, _Mapping]] = ..., button: _Optional[str] = ...) -> None: ...

class Stat(_message.Message):
    __slots__ = ("label", "value")
    LABEL_FIELD_NUMBER: _ClassVar[int]
    VALUE_FIELD_NUMBER: _ClassVar[int]
    label: str
    value: str
    def __init__(self, label: _Optional[str] = ..., value: _Optional[str] = ...) -> None: ...

class StatGrid(_message.Message):
    __slots__ = ("stats",)
    STATS_FIELD_NUMBER: _ClassVar[int]
    stats: _containers.RepeatedCompositeFieldContainer[Stat]
    def __init__(self, stats: _Optional[_Iterable[_Union[Stat, _Mapping]]] = ...) -> None: ...

class Bar(_message.Message):
    __slots__ = ("label", "value")
    LABEL_FIELD_NUMBER: _ClassVar[int]
    VALUE_FIELD_NUMBER: _ClassVar[int]
    label: str
    value: float
    def __init__(self, label: _Optional[str] = ..., value: _Optional[float] = ...) -> None: ...

class BarList(_message.Message):
    __slots__ = ("bars",)
    BARS_FIELD_NUMBER: _ClassVar[int]
    bars: _containers.RepeatedCompositeFieldContainer[Bar]
    def __init__(self, bars: _Optional[_Iterable[_Union[Bar, _Mapping]]] = ...) -> None: ...

class Row(_message.Message):
    __slots__ = ("cells",)
    CELLS_FIELD_NUMBER: _ClassVar[int]
    cells: _containers.RepeatedScalarFieldContainer[str]
    def __init__(self, cells: _Optional[_Iterable[str]] = ...) -> None: ...

class Table(_message.Message):
    __slots__ = ("columns", "rows")
    COLUMNS_FIELD_NUMBER: _ClassVar[int]
    ROWS_FIELD_NUMBER: _ClassVar[int]
    columns: _containers.RepeatedScalarFieldContainer[str]
    rows: _containers.RepeatedCompositeFieldContainer[Row]
    def __init__(self, columns: _Optional[_Iterable[str]] = ..., rows: _Optional[_Iterable[_Union[Row, _Mapping]]] = ...) -> None: ...

class PanelEvent(_message.Message):
    __slots__ = ("panel", "button")
    PANEL_FIELD_NUMBER: _ClassVar[int]
    BUTTON_FIELD_NUMBER: _ClassVar[int]
    panel: str
    button: str
    def __init__(self, panel: _Optional[str] = ..., button: _Optional[str] = ...) -> None: ...

class TimingsRequest(_message.Message):
    __slots__ = ("reset",)
    RESET_FIELD_NUMBER: _ClassVar[int]
    reset: bool
    def __init__(self, reset: _Optional[bool] = ...) -> None: ...

class Timing(_message.Message):
    __slots__ = ("name", "count", "mean_ms", "p50_ms", "p95_ms", "max_ms", "last_ms")
    NAME_FIELD_NUMBER: _ClassVar[int]
    COUNT_FIELD_NUMBER: _ClassVar[int]
    MEAN_MS_FIELD_NUMBER: _ClassVar[int]
    P50_MS_FIELD_NUMBER: _ClassVar[int]
    P95_MS_FIELD_NUMBER: _ClassVar[int]
    MAX_MS_FIELD_NUMBER: _ClassVar[int]
    LAST_MS_FIELD_NUMBER: _ClassVar[int]
    name: str
    count: int
    mean_ms: float
    p50_ms: float
    p95_ms: float
    max_ms: float
    last_ms: float
    def __init__(self, name: _Optional[str] = ..., count: _Optional[int] = ..., mean_ms: _Optional[float] = ..., p50_ms: _Optional[float] = ..., p95_ms: _Optional[float] = ..., max_ms: _Optional[float] = ..., last_ms: _Optional[float] = ...) -> None: ...

class Timings(_message.Message):
    __slots__ = ("timings",)
    TIMINGS_FIELD_NUMBER: _ClassVar[int]
    timings: _containers.RepeatedCompositeFieldContainer[Timing]
    def __init__(self, timings: _Optional[_Iterable[_Union[Timing, _Mapping]]] = ...) -> None: ...

class TestRequest(_message.Message):
    __slots__ = ("videos",)
    VIDEOS_FIELD_NUMBER: _ClassVar[int]
    videos: _containers.RepeatedCompositeFieldContainer[Video]
    def __init__(self, videos: _Optional[_Iterable[_Union[Video, _Mapping]]] = ...) -> None: ...

class FilterVerdict(_message.Message):
    __slots__ = ("blocked", "verdict")
    BLOCKED_FIELD_NUMBER: _ClassVar[int]
    VERDICT_FIELD_NUMBER: _ClassVar[int]
    blocked: bool
    verdict: str
    def __init__(self, blocked: _Optional[bool] = ..., verdict: _Optional[str] = ...) -> None: ...

class TestResult(_message.Message):
    __slots__ = ("id", "hidden", "why", "filters")
    class FiltersEntry(_message.Message):
        __slots__ = ("key", "value")
        KEY_FIELD_NUMBER: _ClassVar[int]
        VALUE_FIELD_NUMBER: _ClassVar[int]
        key: str
        value: FilterVerdict
        def __init__(self, key: _Optional[str] = ..., value: _Optional[_Union[FilterVerdict, _Mapping]] = ...) -> None: ...
    ID_FIELD_NUMBER: _ClassVar[int]
    HIDDEN_FIELD_NUMBER: _ClassVar[int]
    WHY_FIELD_NUMBER: _ClassVar[int]
    FILTERS_FIELD_NUMBER: _ClassVar[int]
    id: str
    hidden: bool
    why: str
    filters: _containers.MessageMap[str, FilterVerdict]
    def __init__(self, id: _Optional[str] = ..., hidden: _Optional[bool] = ..., why: _Optional[str] = ..., filters: _Optional[_Mapping[str, FilterVerdict]] = ...) -> None: ...

class TestResults(_message.Message):
    __slots__ = ("results", "ms")
    RESULTS_FIELD_NUMBER: _ClassVar[int]
    MS_FIELD_NUMBER: _ClassVar[int]
    results: _containers.RepeatedCompositeFieldContainer[TestResult]
    ms: float
    def __init__(self, results: _Optional[_Iterable[_Union[TestResult, _Mapping]]] = ..., ms: _Optional[float] = ...) -> None: ...
