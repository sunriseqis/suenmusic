import SwiftUI

/**
 * 播放队列抽屉 —— **对齐鸿蒙端 \`pages/QueueView.ets\`**。
 *
 * 数据源永远是 \`PlaybackService\` 里镜像的**内核快照**（UI 不持真相）：
 * 删除 / 拖拽 / 跳播都只发意图，由内核改队列并回调下标。
 *
 * 行 = 序号 26 / 曲名 14 / 歌手 11 / 删除键（danger，**与整行点击互不干扰**）；
 * 当前项 accent 文字 + 「播放中」标记；长按拖动排序。
 * hw 没有右滑删除、也没有清空队列 —— 这里一个都不加。
 */
struct QueueSheet: View {
    @EnvironmentObject private var player: PlaybackService
    @Environment(\.colorScheme) private var scheme

    private let bottomInset: CGFloat
    private let onClose: () -> Void

    /// 抽屉高占屏幕比例（hw \`height('70%')\`）
    private static let heightRatio: CGFloat = 0.7

    /// 正在拖的行 + 当前位移（拖拽排序用）
    @State private var dragFrom: Int?
    @State private var dragOffset: CGFloat = 0

    private var p: Palette { Palette(scheme) }

    init(bottomInset: CGFloat, onClose: @escaping () -> Void) {
        self.bottomInset = bottomInset
        self.onClose = onClose
    }

    var body: some View {
        GeometryReader { proxy in
            ZStack(alignment: .bottom) {
                p.scrim
                    .ignoresSafeArea()
                    .contentShape(Rectangle())
                    .onTapGesture(perform: onClose)

                drawer
                    .frame(height: proxy.size.height * Self.heightRatio)
            }
            .frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .bottom)
        }
        .ignoresSafeArea()
    }

    private var drawer: some View {
        VStack(spacing: 0) {
            header
            if player.queue.isEmpty {
                EmptyState(title: Copy.queueEmptyTitle, subtitle: Copy.queueEmptySub)
            } else {
                list
            }
        }
        .padding(.top, Dim.s1)
        .padding(.bottom, bottomInset)
        .background(
            UnevenRoundedRectangle(topLeadingRadius: Dim.radiusLg,
                                   topTrailingRadius: Dim.radiusLg,
                                   style: .continuous)
                .fill(p.bg)
        )
    }

    // MARK: - 头（标题 + 首数 + 收起）

    private var header: some View {
        HStack(spacing: Dim.s2) {
            Text("播放队列")
                .font(.system(size: Dim.fsTitle, weight: .medium))
                .foregroundStyle(p.text1)
            Spacer(minLength: 0)
            Text("\(player.queue.count) 首")
                .font(.system(size: Dim.fsCaption))
                .foregroundStyle(p.text2)
            WebIconButton(.chevronDown, box: Dim.btnMd, style: .plain, action: onClose)
                .accessibilityLabel("收起队列")
        }
        .padding(.leading, Dim.s4)
        .padding(.trailing, Dim.s3)
        .padding(.top, Dim.s3)
        .padding(.bottom, Dim.s2)
    }

    // MARK: - 列表

    private var list: some View {
        ScrollView {
            LazyVStack(spacing: 0) {
                ForEach(player.queue.indices, id: \.self) { index in
                    row(index, player.queue[index])
                }
            }
        }
        .scrollIndicators(.hidden)
    }

    private func row(_ index: Int, _ item: Track) -> some View {
        let current = index == player.currentIndex
        let dragging = dragFrom == index
        return VStack(spacing: 0) {
            HStack(spacing: Dim.s2) {
                // 序号 + 曲名 + 歌手 + 播放中：这一整块才是「整行点击」
                HStack(spacing: Dim.s2) {
                    Text("\(index + 1)")
                        .font(.system(size: Dim.fsCaption))
                        .foregroundStyle(current ? p.accent : p.text2)
                        .frame(width: Dim.seqW, alignment: .center)
                    VStack(alignment: .leading, spacing: Dim.s0) {
                        Text(item.name)
                            .font(.system(size: Dim.fsSub))
                            .foregroundStyle(current ? p.accent : p.text1)
                            .lineLimit(1)
                            .truncationMode(.tail)
                        Text(item.artistLine)
                            .font(.system(size: Dim.fsCaption))
                            .foregroundStyle(p.text2)
                            .lineLimit(1)
                    }
                    Spacer(minLength: Dim.s2)
                    if current {
                        Text("播放中")
                            .font(.system(size: Dim.fsCaption))
                            .foregroundStyle(p.accent)
                    }
                }
                .contentShape(Rectangle())
                .onTapGesture { player.jumpTo(index) }
                .gesture(reorder(index))

                // 删除键：danger 透明底红字；独立按钮 → 点它不会触发整行跳播
                WebButton("删除", variant: .danger, size: .sm) {
                    Task { await player.removeAt(index) }
                }
                .accessibilityLabel("从队列删除 \(item.name)")
            }
            .padding(.leading, Dim.s3)
            .padding(.trailing, Dim.s3)
            .frame(height: Dim.rowHeight)
            .background(current ? p.panel : p.bg)
            .offset(y: dragging ? dragOffset : 0)
            .zIndex(dragging ? 1 : 0)

            Rectangle()
                .fill(p.line)
                .frame(height: Dim.hairline)
        }
    }

    /// 长按后拖动排序（hw \`onItemDragStart/onItemDrop\`）：只把两个下标丢给内核
    private func reorder(_ index: Int) -> some Gesture {
        LongPressGesture(minimumDuration: Motion.clickGuard)
            .sequenced(before: DragGesture())
            .onChanged { value in
                guard case .second(true, let drag?) = value else { return }
                if dragFrom == nil { dragFrom = index }
                dragOffset = drag.translation.height
            }
            .onEnded { value in
                defer {
                    dragFrom = nil
                    dragOffset = 0
                }
                guard case .second(true, let drag?) = value, let from = dragFrom else { return }
                let steps = Int((drag.translation.height / Dim.rowHeight).rounded())
                let to = min(max(0, from + steps), player.queue.count - 1)
                guard to != from else { return }
                player.moveItem(from: from, to: to)
            }
    }
}
