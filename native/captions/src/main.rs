use std::{
    collections::VecDeque,
    env,
    error::Error,
    io::{self, BufRead, Write},
    path::PathBuf,
    sync::{
        Arc,
        atomic::{AtomicBool, Ordering},
    },
    thread,
};

use serde_json::json;
use sherpa_onnx::{OnlineRecognizer, OnlineRecognizerConfig};
use wasapi::{DeviceEnumerator, Direction, SampleType, StreamMode, WaveFormat, initialize_mta};

const SAMPLE_RATE: usize = 16_000;

fn emit(value: serde_json::Value) {
    println!("{value}");
    let _ = io::stdout().flush();
}

fn model_config(model_dir: &std::path::Path) -> OnlineRecognizerConfig {
    let mut config = OnlineRecognizerConfig::default();
    config.model_config.transducer.encoder = Some(
        model_dir
            .join("encoder-epoch-99-avg-1-chunk-16-left-128.int8.onnx")
            .to_string_lossy()
            .into_owned(),
    );
    config.model_config.transducer.decoder = Some(
        model_dir
            .join("decoder-epoch-99-avg-1-chunk-16-left-128.onnx")
            .to_string_lossy()
            .into_owned(),
    );
    config.model_config.transducer.joiner = Some(
        model_dir
            .join("joiner-epoch-99-avg-1-chunk-16-left-128.int8.onnx")
            .to_string_lossy()
            .into_owned(),
    );
    config.model_config.tokens = Some(model_dir.join("tokens.txt").to_string_lossy().into_owned());
    config.model_config.provider = Some("cpu".to_owned());
    config.enable_endpoint = true;
    config.decoding_method = Some("greedy_search".to_owned());
    config
}

fn run(model_dir: PathBuf, stop: Arc<AtomicBool>) -> Result<(), Box<dyn Error>> {
    let config = model_config(&model_dir);
    let recognizer =
        OnlineRecognizer::create(&config).ok_or("Could not initialize the local speech model")?;
    let stream = recognizer.create_stream();

    initialize_mta().ok()?;
    let enumerator = DeviceEnumerator::new()?;
    let render_device = enumerator.get_default_device(&Direction::Render)?;
    let mut audio_client = render_device.get_iaudioclient()?;
    // Capture from the default output endpoint in WASAPI shared-mode loopback.
    // Windows performs the output device's rate/channel conversion to mono 16 kHz.
    let desired = WaveFormat::new(32, 32, &SampleType::Float, SAMPLE_RATE, 1, None);
    let (default_period, _) = audio_client.get_device_period()?;
    let mode = StreamMode::EventsShared {
        autoconvert: true,
        buffer_duration_hns: default_period,
    };
    audio_client.initialize_client(&desired, &Direction::Capture, &mode)?;
    let event = audio_client.set_get_eventhandle()?;
    let capture_client = audio_client.get_audiocaptureclient()?;
    audio_client.start_stream()?;

    emit(json!({ "type": "status", "message": "Listening to system audio · On device" }));
    let mut bytes = VecDeque::<u8>::new();
    let mut samples = Vec::<f32>::with_capacity(320);
    let mut last_text = String::new();

    while !stop.load(Ordering::Relaxed) {
        if event.wait_for_event(100).is_err() {
            continue;
        }
        capture_client.read_from_device_to_deque(&mut bytes)?;

        while bytes.len() >= 4 {
            let raw = [
                bytes.pop_front().unwrap(),
                bytes.pop_front().unwrap(),
                bytes.pop_front().unwrap(),
                bytes.pop_front().unwrap(),
            ];
            samples.push(f32::from_le_bytes(raw));
        }

        while samples.len() >= 320 {
            let chunk: Vec<f32> = samples.drain(..320).collect();
            stream.accept_waveform(SAMPLE_RATE as i32, &chunk);
            while recognizer.is_ready(&stream) {
                recognizer.decode(&stream);
            }
            let result = recognizer
                .get_result(&stream)
                .map(|result| result.text)
                .unwrap_or_default();
            if !result.is_empty() && result != last_text {
                last_text.clone_from(&result);
                let final_text = recognizer.is_endpoint(&stream);
                emit(
                    json!({ "type": if final_text { "final" } else { "partial" }, "text": result }),
                );
                if final_text {
                    recognizer.reset(&stream);
                    last_text.clear();
                }
            }
        }
    }

    let _ = audio_client.stop_stream();
    emit(json!({ "type": "stopped" }));
    Ok(())
}

fn main() {
    let Some(model_dir) = env::args_os().nth(1).map(PathBuf::from) else {
        emit(json!({ "type": "error", "message": "Speech model folder was not provided." }));
        std::process::exit(2);
    };
    let stop = Arc::new(AtomicBool::new(false));
    let stop_from_stdin = Arc::clone(&stop);
    thread::spawn(move || {
        let stdin = io::stdin();
        for line in stdin.lock().lines() {
            if matches!(line.as_deref(), Ok("stop")) {
                stop_from_stdin.store(true, Ordering::Relaxed);
                break;
            }
        }
    });

    if let Err(error) = run(model_dir, stop) {
        emit(json!({ "type": "error", "message": error.to_string() }));
        std::process::exit(1);
    }
}
