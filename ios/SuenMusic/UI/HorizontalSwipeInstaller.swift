import SwiftUI
import UIKit

/// 只认「向右横向拖动」的手势桥（替代行内 SwiftUI `DragGesture`）。
///
/// 为什么必须换：SwiftUI 的 `DragGesture` 挂在行上会和外层 `UIScrollView` 抢手势，
/// 实测「手指落在行上就滑不动列表，只有空白处能滚」。UIKit 的 pan 识别器可以
/// ① `gestureRecognizerShouldBegin` 只在明显横向时接管；② 与滚动识别器**并行识别**。
/// 自身视图 `isUserInteractionEnabled = false`，点击/滚动照常透传。
struct HorizontalSwipeInstaller: UIViewRepresentable {
    let onChanged: (CGFloat) -> Void
    let onEnded: () -> Void

    func makeCoordinator() -> Coordinator { Coordinator(self) }

    func makeUIView(context: Context) -> UIView {
        let probe = UIView()
        probe.isUserInteractionEnabled = false
        probe.backgroundColor = .clear
        DispatchQueue.main.async { install(from: probe, coordinator: context.coordinator) }
        return probe
    }

    func updateUIView(_ uiView: UIView, context: Context) {
        context.coordinator.parent = self
    }

    private func install(from probe: UIView, coordinator: Coordinator) {
        guard let host = probe.superview else { return }
        let existing = host.gestureRecognizers?.contains { $0 is SwipePan } == true
        guard !existing else { return }
        let pan = SwipePan(target: coordinator, action: #selector(Coordinator.handle(_:)))
        pan.delegate = coordinator
        pan.cancelsTouchesInView = false
        host.addGestureRecognizer(pan)
    }

    final class SwipePan: UIPanGestureRecognizer {}

    final class Coordinator: NSObject, UIGestureRecognizerDelegate {
        var parent: HorizontalSwipeInstaller
        init(_ parent: HorizontalSwipeInstaller) { self.parent = parent }

        func gestureRecognizerShouldBegin(_ g: UIGestureRecognizer) -> Bool {
            guard g is SwipePan, let view = g.view as? UIView else { return false }
            // ⚠️ 必须用 velocity，不能用 translation：在「将要开始」这一刻 translation 恒为 (0,0)，
            //    拿它判断会永远 return false —— 这就是上一版「右滑无效」的原因。
            //    velocity 在此刻已有方向，可用它区分横向/纵向。
            let v = (g as! SwipePan).velocity(in: view)
            return v.x > 0 && abs(v.x) > abs(v.y)
        }

        func gestureRecognizer(_ g: UIGestureRecognizer,
                              shouldRecognizeSimultaneouslyWith other: UIGestureRecognizer) -> Bool {
            true
        }

        @objc func handle(_ pan: SwipePan) {
            guard let view = pan.view else { return }
            switch pan.state {
            case .changed:
                parent.onChanged(pan.translation(in: view).x)
            case .ended, .cancelled, .failed:
                parent.onEnded()
            default:
                break
            }
        }
    }
}