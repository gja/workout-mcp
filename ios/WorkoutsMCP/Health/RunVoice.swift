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

import AVFoundation
import Foundation

@MainActor
final class RunVoice: NSObject {
    /// Off is the athlete's to choose, in Settings. Read each time rather than held, so
    /// turning it off mid-run takes effect at the next thing there was to say.
    static let defaultsKey = "run-voice"
    static var isOn: Bool { UserDefaults.standard.object(forKey: defaultsKey) as? Bool ?? true }

    private let synthesizer = AVSpeechSynthesizer()

    /// What is still being said. The session is released on the way back to zero and not on
    /// each utterance, or two announcements in a row would hand the music back in between.
    private var pending = 0

    override init() {
        super.init()
        synthesizer.delegate = self
    }

    func say(_ words: String) {
        guard Self.isOn, !words.isEmpty else { return }

        activate()
        pending += 1
        synthesizer.speak(AVSpeechUtterance(string: words))
    }

    /// Cut off rather than waited for: whatever was being said is about an interval that has
    /// finished, and the athlete has already stopped.
    func stop() {
        synthesizer.stopSpeaking(at: .immediate)
        pending = 0
        release()
    }

    private func activate() {
        guard pending == 0 else { return }
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

    private func finished() {
        pending = max(0, pending - 1)
        if pending == 0 { release() }
    }
}

extension RunVoice: AVSpeechSynthesizerDelegate {
    nonisolated func speechSynthesizer(
        _ synthesizer: AVSpeechSynthesizer, didFinish utterance: AVSpeechUtterance
    ) {
        Task { @MainActor in self.finished() }
    }

    nonisolated func speechSynthesizer(
        _ synthesizer: AVSpeechSynthesizer, didCancel utterance: AVSpeechUtterance
    ) {
        Task { @MainActor in self.finished() }
    }
}
