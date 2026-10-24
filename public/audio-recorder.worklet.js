class MicrophoneCapture extends AudioWorkletProcessor {
  process(inputs) {
    const samples = inputs[0]?.[0];
    if (samples?.length) this.port.postMessage(samples.slice());
    return true;
  }
}
registerProcessor('microphone-capture', MicrophoneCapture);
