/**
 * 图标库 —— 与鸿蒙端 `common/WebIcons.ets` 同表同渲染口径（SF Symbols 为 hw sys.symbol 的等价物）。
 *
 * 渲染：fontSize 即图标 em 尺寸；字重固定 Medium（原生默认 Regular 偏细，hw 同补偿）。
 * 页面里禁止再用 `Image(systemName:)` 裸写符号名。
 */

import SwiftUI

enum WebIconName {
    case dots, play, pause, prev, next, search, heart, heartFilled, list, close
    case chevronDown, chevronLeft, chevronRight, chevronUp, plus
    case modeOrder, modeLoop, modeRepeatOne, modeShuffle, modeShuffleOnce
    case pin, dislikeSong, dislikeArtist
}

extension WebIconName {
    /// 无精确对应的取语义最近符号：modeOrder → arrow.right、modeShuffleOnce → shuffle
    var symbolName: String {
        switch self {
        case .dots: return "ellipsis"
        case .play: return "play.fill"
        case .pause: return "pause.fill"
        case .prev: return "backward.end.fill"
        case .next: return "forward.end.fill"
        case .search: return "magnifyingglass"
        case .heart: return "heart"
        case .heartFilled: return "heart.fill"
        case .list: return "list.bullet"
        case .close: return "xmark"
        case .chevronDown: return "chevron.down"
        case .chevronLeft: return "chevron.left"
        case .chevronRight: return "chevron.right"
        case .chevronUp: return "chevron.up"
        case .plus: return "plus"
        case .modeOrder: return "arrow.right"
        case .modeLoop: return "repeat"
        case .modeRepeatOne: return "repeat.1"
        case .modeShuffle: return "shuffle"
        case .modeShuffleOnce: return "shuffle"
        case .pin: return "pin"
        case .dislikeSong: return "hand.thumbsdown"
        case .dislikeArtist: return "hand.thumbsdown.fill"
        }
    }

    /// 未知兜底：列表（最中性图形），绝不让按钮画成空白
    static let fallbackSymbolName = "list.bullet"
}

struct WebIcon: View {
    private let name: WebIconName
    private let size: CGFloat

    init(_ name: WebIconName, size: CGFloat) {
        self.name = name
        self.size = size
    }

    var body: some View {
        Image(systemName: name.symbolName)
            .font(.system(size: size, weight: .medium))
    }
}
