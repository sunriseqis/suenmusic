import SwiftUI

extension View {
    /// `List` 行统一外观：去掉系统内边距、分割线与背景，让 TrackRow 自己决定视觉。
    /// 右滑收藏改用 `List` + `.swipeActions` 后，各处行都要套这一层（否则行会被 List 的内边距缩进）。
    func listRowChrome() -> some View {
        listRowInsets(EdgeInsets())
            .listRowSeparator(.hidden)
            .listRowBackground(Color.clear)
    }
}