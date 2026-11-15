import time
import uuid

from django.test import SimpleTestCase

from conversations.voice_stream import VoiceStreamSession, _diff_sentences, _extract_completed_sentences


class VoiceStreamSentenceTests(SimpleTestCase):
    def test_extract_completed_sentences(self):
        text = "Hi there. How are you? I'm good"
        sentences = _extract_completed_sentences(text)
        self.assertEqual(sentences, ["Hi there.", "How are you?"])

    def test_diff_sentences_emits_new_and_skips_duplicates(self):
        session = VoiceStreamSession(
            stream_id=uuid.uuid4(),
            conversation_id=uuid.uuid4(),
            created_at=time.time(),
            last_chunk_at=time.time(),
        )

        first_transcript = "Hello world. Another sentence!"
        emitted = _diff_sentences(session, first_transcript, is_final=False)
        self.assertEqual(emitted, ["Hello world.", "Another sentence!"])

        # Repeat transcript should not re-emit
        emitted_again = _diff_sentences(session, first_transcript, is_final=False)
        self.assertEqual(emitted_again, [])

        # Final chunk without punctuation should still emit trailing text once
        final_transcript = "Hello world. Another sentence! trailing words"
        final_emitted = _diff_sentences(session, final_transcript, is_final=True)
        self.assertEqual(final_emitted, ["trailing words"])
