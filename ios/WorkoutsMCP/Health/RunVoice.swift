// What the athlete hears. Apple's own synthesiser, over whatever they are listening to.
//
// The audio session is the whole of the difficulty. It is activated for an utterance and
// deactivated as soon as the last one finishes, because a session held open for the length
// of a run would duck the music for the length of the run. `.duckOthers` turns music down
// and `.interruptSpokenAudioAndMixWithOthers` pauses a podcast instead, which is what an
// athlete listening to one wants: a sentence under a sentence is neither.
//
// Speaking with the screen off needs the `audio` background mode, which `Info.plist` carries
// beside `location` — announcements are for the phone in an armband, which is when nobody is
// looking at any of this.

// Compiled only where `ON_PHONE_RECORDING` is — Debug, and not an archive. See
// "Recording it on the phone" in docs/ios.md.

#if ON_PHONE_RECORDING
import AVFoundation
import Foundation

@MainActor
final class RunVoice: NSObject {
    /// Off is the athlete's to choose, in Settings. Read each time rather than held, so
    /// turning it off mid-run takes effect at the next thing there was to say.
    static let defaultsKey = "run-voice"
    static var isOn: Bool { UserDefaults.standard.object(forKey: defaultsKey) as? Bool ?? true }

    private let synthesizer = AVSpeechSynthesizer()

    /// What is still being said. The session is released when the last one finishes and not
    /// on each utterance, or two announcements in a row would hand the music back in between.
    ///
    /// Held by identity rather than as a count. A count cannot tell a
    /// callback for something `stop` cancelled from one for what is being said now: the
    /// cancellations hop to the main actor after `stop` has already zeroed it, and a `say`
    /// landing in that gap had its audio session deactivated mid-sentence by the stale one.
    private var live = Set<ObjectIdentifier>()

    override init() {
        super.init()
        synthesizer.delegate = self
    }

    func say(_ words: String) {
        guard Self.isOn, !words.isEmpty else { return }

        activate()
        let utterance = AVSpeechUtterance(string: words)
        live.insert(ObjectIdentifier(utterance))
        synthesizer.speak(utterance)
    }

    /// Cut off rather than waited for: whatever was being said is about an interval that has
    /// finished, and the athlete has already stopped.
    func stop() {
        synthesizer.stopSpeaking(at: .immediate)
        live.removeAll()
        release()
    }

    private func activate() {
        guard live.isEmpty else { return }
        let session = AVAudioSession.sharedInstance()
        try? session.setCategory(
            .playback,
            mode: .voicePrompt,
            options: [.duckOthers, .interruptSpokenAudioAndMixWithOthers]
        )
        try? session.setActive(true)
    }

    private func release() {
        // Others are told, or the music comes back at the volume it was ducked to and stays
        // there until something else happens to it.
        try? AVAudioSession.sharedInstance().setActive(false, options: .notifyOthersOnDeactivation)
    }

    private func finished(_ utterance: AVSpeechUtterance) {
        // Not one of ours any more — `stop` wrote it off, and what is speaking now is not it.
        guard live.remove(ObjectIdentifier(utterance)) != nil else { return }
        if live.isEmpty { release() }
    }
}

extension RunVoice: AVSpeechSynthesizerDelegate {
    nonisolated func speechSynthesizer(
        _ synthesizer: AVSpeechSynthesizer, didFinish utterance: AVSpeechUtterance
    ) {
        Task { @MainActor in self.finished(utterance) }
    }

    nonisolated func speechSynthesizer(
        _ synthesizer: AVSpeechSynthesizer, didCancel utterance: AVSpeechUtterance
    ) {
        Task { @MainActor in self.finished(utterance) }
    }
}

#endif
