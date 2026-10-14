using System.Text.Json;
using Microsoft.Windows.AI;
using Microsoft.Windows.AI.Speech;
using NAudio.CoreAudioApi;
using NAudio.Wave;
using NAudio.Wave.SampleProviders;

internal static class Program
{
    private const int TargetSampleRate = 16_000;
    private const int SamplesPerFrame = 320; // 20 ms, mono 16 kHz PCM.
    private static readonly object OutputLock = new();

    private static async Task<int> Main(string[] args)
    {
        using var stop = new CancellationTokenSource();
        Console.CancelKeyPress += (_, eventArgs) =>
        {
            eventArgs.Cancel = true;
            stop.Cancel();
        };

        try
        {
            Emit(new { type = "status", message = "Preparing Windows on-device speech recognition…" });

            var factory = SpeechRecognitionModelFactory.Default;
            var readiness = factory.GetReadyState();
            if (readiness != AIFeatureReadyState.Ready)
            {
                if (readiness == AIFeatureReadyState.NotSupportedOnCurrentSystem)
                {
                    throw new InvalidOperationException("Windows on-device speech recognition is not supported on this PC.");
                }

                if (!args.Contains("--download-model", StringComparer.OrdinalIgnoreCase))
                {
                    Emit(new { type = "needs-model-consent", state = readiness.ToString() });
                    return 20;
                }

                Emit(new { type = "status", message = "Downloading Windows on-device speech model…" });
                var result = await factory.EnsureReadyAsync();
                if (result.Status != AIFeatureReadyResultState.Success)
                {
                    throw new InvalidOperationException($"Windows speech model setup failed: {result.ExtendedError}");
                }
            }

            using var model = await factory.CreateAsync();
            using var provider = new SpeechAudioProvider();
            var audioConfiguration = AudioConfiguration.ForProvider(provider);
            using var recognition = new StreamingRecognition(audioConfiguration, model);
            recognition.Recognizing += (_, args) =>
            {
                if (!string.IsNullOrWhiteSpace(args.Text)) Emit(new { type = "partial", text = args.Text });
            };
            recognition.Recognized += (_, args) =>
            {
                if (!string.IsNullOrWhiteSpace(args.Text)) Emit(new { type = "final", text = args.Text });
            };

            await recognition.StartContinuousRecognitionAsync();
            using var capture = new SystemAudioCapture(provider);
            capture.Start();
            Emit(new { type = "status", message = "Listening to system audio · Windows on-device" });

            var stopInput = Task.Run(() => Console.ReadLine());
            while (!stop.IsCancellationRequested)
            {
                if (stopInput.IsCompleted)
                {
                    stop.Cancel();
                    break;
                }
                await Task.Delay(40, stop.Token).ContinueWith(_ => { }, TaskScheduler.Default);
            }

            capture.Stop();
            await recognition.StopContinuousRecognitionAsync();
            Emit(new { type = "stopped" });
            return 0;
        }
        catch (Exception error)
        {
            Emit(new { type = "error", message = error.Message });
            return 1;
        }
    }

    private static void Emit(object value)
    {
        lock (OutputLock)
        {
            Console.WriteLine(JsonSerializer.Serialize(value));
            Console.Out.Flush();
        }
    }

    private sealed class SystemAudioCapture : IDisposable
    {
        private readonly SpeechAudioProvider provider;
        private readonly MMDeviceEnumerator enumerator;
        private readonly MMDevice device;
        private readonly WasapiLoopbackCapture capture;
        private readonly BufferedWaveProvider buffer;
        private readonly ISampleProvider resampled;
        private readonly CancellationTokenSource stop = new();
        private readonly Task pump;

        public SystemAudioCapture(SpeechAudioProvider provider)
        {
            this.provider = provider;
            enumerator = new MMDeviceEnumerator();
            device = enumerator.GetDefaultAudioEndpoint(DataFlow.Render, Role.Multimedia);
            capture = new WasapiLoopbackCapture(device);
            buffer = new BufferedWaveProvider(capture.WaveFormat)
            {
                BufferDuration = TimeSpan.FromSeconds(2),
                DiscardOnBufferOverflow = true,
                ReadFully = false,
            };

            capture.DataAvailable += (_, args) => buffer.AddSamples(args.Buffer, 0, args.BytesRecorded);

            ISampleProvider mono = buffer.ToSampleProvider();
            if (mono.WaveFormat.Channels == 2)
            {
                mono = new StereoToMonoSampleProvider(mono)
                {
                    LeftVolume = 0.5f,
                    RightVolume = 0.5f,
                };
            }
            else if (mono.WaveFormat.Channels != 1)
            {
                throw new NotSupportedException($"Windows speech captions do not support {mono.WaveFormat.Channels}-channel playback.");
            }

            resampled = new WdlResamplingSampleProvider(mono, TargetSampleRate);
            pump = Task.Run(PumpAudio);
        }

        public void Start() => capture.StartRecording();

        public void Stop()
        {
            stop.Cancel();
            capture.StopRecording();
            try { pump.Wait(TimeSpan.FromSeconds(2)); } catch (AggregateException) { }
        }

        private void PumpAudio()
        {
            try
            {
                var frame = new float[SamplesPerFrame];
                var pending = 0;

                while (!stop.IsCancellationRequested)
                {
                    var count = resampled.Read(frame, pending, SamplesPerFrame - pending);
                    if (count == 0)
                    {
                        Thread.Sleep(10);
                        continue;
                    }

                    pending += count;
                    if (pending < SamplesPerFrame) continue;

                    var pcm = new ushort[SamplesPerFrame];
                    for (var index = 0; index < SamplesPerFrame; index++)
                    {
                        var sample = Math.Clamp(frame[index], -1f, 1f);
                        var signed = (short)Math.Round(sample * (sample < 0 ? short.MaxValue + 1f : short.MaxValue));
                        pcm[index] = unchecked((ushort)signed);
                    }
                    provider.PushData(pcm);
                    pending = 0;
                }
            }
            catch (Exception error)
            {
                Emit(new { type = "error", message = $"System-audio stream failed: {error.Message}" });
            }
        }

        public void Dispose()
        {
            Stop();
            capture.Dispose();
            device.Dispose();
            enumerator.Dispose();
            stop.Dispose();
        }
    }
}
