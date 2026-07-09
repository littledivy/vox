package main

import (
	"encoding/base64"
	"encoding/binary"
	"math"
	"strings"
)

// isSilent checks if a PCM int16 audio frame is silence (RMS below threshold).
func isSilent(pcm []byte) bool {
	if len(pcm) < 2 {
		return true
	}
	var sumSq float64
	n := len(pcm) / 2
	for i := 0; i < n; i++ {
		sample := int16(binary.LittleEndian.Uint16(pcm[i*2:]))
		sumSq += float64(sample) * float64(sample)
	}
	rms := math.Sqrt(sumSq / float64(n))
	return rms < 50
}

// computeRMS calculates the root-mean-square of PCM16LE audio.
func computeRMS(pcm16le []byte) float64 {
	samples := len(pcm16le) / 2
	if samples == 0 {
		return 0
	}
	var sumSq float64
	for i := 0; i < samples; i++ {
		sample := int16(binary.LittleEndian.Uint16(pcm16le[i*2 : i*2+2]))
		normalized := float64(sample) / 32768.0
		sumSq += normalized * normalized
	}
	return math.Sqrt(sumSq / float64(samples))
}

// resample16to24kHz resamples PCM16LE from 16kHz to 24kHz using linear interpolation.
func resample16to24kHz(pcm16le []byte) []byte {
	inputSamples := len(pcm16le) / 2
	if inputSamples == 0 {
		return nil
	}
	outputSamples := inputSamples * 3 / 2
	output := make([]byte, outputSamples*2)

	for i := 0; i < outputSamples; i++ {
		srcIdx := float64(i) * 16000.0 / 24000.0
		idx0 := int(srcIdx)
		frac := srcIdx - float64(idx0)
		idx1 := idx0 + 1
		if idx1 >= inputSamples {
			idx1 = inputSamples - 1
		}

		s0 := int16(binary.LittleEndian.Uint16(pcm16le[idx0*2 : idx0*2+2]))
		s1 := int16(binary.LittleEndian.Uint16(pcm16le[idx1*2 : idx1*2+2]))

		interpolated := float64(s0)*(1-frac) + float64(s1)*frac
		sample := int16(math.Round(interpolated))
		binary.LittleEndian.PutUint16(output[i*2:i*2+2], uint16(sample))
	}

	return output
}

// encodeWAV wraps raw PCM data in a WAV container.
func encodeWAV(pcm []byte, sampleRate, channels, bitsPerSample int) []byte {
	dataSize := len(pcm)
	fileSize := 36 + dataSize
	byteRate := sampleRate * channels * bitsPerSample / 8
	blockAlign := channels * bitsPerSample / 8

	buf := make([]byte, 44+dataSize)
	copy(buf[0:4], "RIFF")
	binary.LittleEndian.PutUint32(buf[4:8], uint32(fileSize))
	copy(buf[8:12], "WAVE")
	copy(buf[12:16], "fmt ")
	binary.LittleEndian.PutUint32(buf[16:20], 16)
	binary.LittleEndian.PutUint16(buf[20:22], 1)
	binary.LittleEndian.PutUint16(buf[22:24], uint16(channels))
	binary.LittleEndian.PutUint32(buf[24:28], uint32(sampleRate))
	binary.LittleEndian.PutUint32(buf[28:32], uint32(byteRate))
	binary.LittleEndian.PutUint16(buf[32:34], uint16(blockAlign))
	binary.LittleEndian.PutUint16(buf[34:36], uint16(bitsPerSample))
	copy(buf[36:40], "data")
	binary.LittleEndian.PutUint32(buf[40:44], uint32(dataSize))
	copy(buf[44:], pcm)
	return buf
}

// extractPCMFromWAV strips the WAV header and returns raw PCM data.
func extractPCMFromWAV(wav []byte) []byte {
	for i := 12; i+8 < len(wav); {
		id := string(wav[i : i+4])
		size := int(binary.LittleEndian.Uint32(wav[i+4 : i+8]))
		if id == "data" {
			start := i + 8
			end := start + size
			if end > len(wav) {
				end = len(wav)
			}
			return wav[start:end]
		}
		i += 8 + size
		if size%2 != 0 {
			i++
		}
	}
	if len(wav) > 44 {
		return wav[44:]
	}
	return wav
}

// chunkPCMAudio splits PCM data into chunks and calls fn with each base64-encoded chunk.
func chunkPCMAudio(pcm []byte, sampleRate int, chunkMs int, fn func(base64Audio string)) {
	bytesPerChunk := sampleRate * 2 * chunkMs / 1000
	for offset := 0; offset < len(pcm); offset += bytesPerChunk {
		end := offset + bytesPerChunk
		if end > len(pcm) {
			end = len(pcm)
		}
		chunk := pcm[offset:end]
		fn(base64.StdEncoding.EncodeToString(chunk))
	}
}

// isFillerOnly returns true if the text is just a filler word.
func isFillerOnly(text string) bool {
	lower := strings.ToLower(strings.TrimSpace(text))
	fillers := []string{
		"you", "thank you.", "thanks.", "bye.", "okay.",
		"um", "uh", "hmm", "mm", "ah",
		".", "", "...",
	}
	for _, f := range fillers {
		if lower == f {
			return true
		}
	}
	return len(lower) < 3
}

// stripThinkingTags removes <think>...</think> blocks from model output.
func stripThinkingTags(s string) string {
	for {
		start := strings.Index(s, "<think>")
		if start == -1 {
			break
		}
		end := strings.Index(s, "</think>")
		if end == -1 {
			s = s[:start]
			break
		}
		s = s[:start] + s[end+len("</think>"):]
	}
	return strings.TrimSpace(s)
}
