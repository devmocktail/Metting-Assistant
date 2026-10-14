//! Local WASAPI render-loopback transport. stdout is exclusively f32 LE / 16 kHz / mono.
//! Device/status events are JSON lines on stderr. No microphone or network access.
use std::{collections::VecDeque, error::Error, io::{self, BufRead, Write},
    sync::{Arc, atomic::{AtomicBool, Ordering}}, thread, time::{Duration, Instant}};
use serde_json::json;
use wasapi::{DeviceEnumerator, Direction, SampleType, StreamMode, WaveFormat, initialize_mta};

fn event(value: serde_json::Value) { eprintln!("{value}"); }

fn capture(device_id: Option<&str>, stop: &AtomicBool, streamed: &mut bool) -> Result<(), Box<dyn Error>> {
    let enumerator = DeviceEnumerator::new()?;
    let device = match device_id {
        Some(id) => enumerator.get_device(id)?,
        None => enumerator.get_default_device(&Direction::Render)?,
    };
    let id = device.get_id()?;
    let name = device.get_friendlyname()?;
    let mut client = device.get_iaudioclient()?;
    let format = WaveFormat::new(32, 32, &SampleType::Float, 16_000, 1, None);
    let (period, _) = client.get_device_period()?;
    client.initialize_client(&format, &Direction::Capture,
        &StreamMode::EventsShared { autoconvert: true, buffer_duration_hns: period })?;
    let ready = client.set_get_eventhandle()?;
    let reader = client.get_audiocaptureclient()?;
    client.start_stream()?;
    *streamed = true;
    event(json!({"type":"source", "name":name}));
    let mut bytes = VecDeque::new();
    let mut output = io::stdout().lock();
    let mut last_packet = Instant::now();
    let mut last_device_check = Instant::now();
    let result = (|| -> Result<(), Box<dyn Error>> {
        while !stop.load(Ordering::Relaxed) {
            if ready.wait_for_event(20).is_ok() {
                let info = reader.read_from_device_to_deque(&mut bytes)?;
                if info.flags.silent { bytes.iter_mut().for_each(|b| *b = 0); }
            }
            if !bytes.is_empty() {
                let block: Vec<u8> = bytes.drain(..).collect();
                output.write_all(&block)?;
                output.flush()?;
                last_packet = Instant::now();
            } else if last_packet.elapsed() >= Duration::from_millis(100) {
                // WASAPI may stop producing packets when playback is idle. Preserve
                // silence so speech endpointing can finish the final phrase.
                output.write_all(&[0_u8; 1600 * 4])?;
                output.flush()?;
                last_packet = Instant::now();
            }
            if device_id.is_none() && last_device_check.elapsed() >= Duration::from_secs(1) {
                last_device_check = Instant::now();
                if enumerator.get_default_device(&Direction::Render)?.get_id()? != id {
                    break;
                }
            }
        }
        Ok(())
    })();
    let _ = client.stop_stream();
    result
}

fn main() {
    if let Err(error) = initialize_mta().ok() {
        event(json!({"type":"error", "message":error.to_string()}));
        std::process::exit(1);
    }
    let args: Vec<String> = std::env::args().collect();
    if args.iter().any(|a| a == "--list-devices") {
        let result = (|| -> Result<(), Box<dyn Error>> {
            let devices = DeviceEnumerator::new()?.get_device_collection(&Direction::Render)?;
            let mut list = Vec::new();
            for i in 0..devices.get_nbr_devices()? {
                let device = devices.get_device_at_index(i)?;
                list.push(json!({"id":device.get_id()?, "name":device.get_friendlyname()?}));
            }
            println!("{}", json!(list));
            Ok(())
        })();
        if let Err(error) = result { event(json!({"type":"error", "message":error.to_string()})); std::process::exit(1); }
        return;
    }
    let device = args.iter().position(|a| a == "--device").and_then(|i| args.get(i + 1));
    let stop = Arc::new(AtomicBool::new(false));
    let input_stop = stop.clone();
    thread::spawn(move || {
        for line in io::stdin().lock().lines() {
            if matches!(line.as_deref(), Ok("stop") | Err(_)) { break; }
        }
        // EOF also stops capture when the parent exits unexpectedly.
        input_stop.store(true, Ordering::Relaxed);
    });
    let mut last_warning: Option<(String, Instant)> = None;
    while !stop.load(Ordering::Relaxed) {
        let mut streamed = false;
        if let Err(error) = capture(device.map(String::as_str), &stop, &mut streamed) {
            if stop.load(Ordering::Relaxed) { break; }
            // Report a repeated failure every 10 s, not on every retry.
            let message = error.to_string();
            if last_warning.as_ref().map_or(true, |(m, at)| *m != message || at.elapsed() >= Duration::from_secs(10)) {
                let what = if device.is_some() { "The selected playback output is unavailable" } else { "No playback output is available" };
                event(json!({"type":"capture-warning", "message":format!("{what}. Captions resume when it is connected. ({message})")}));
                last_warning = Some((message, Instant::now()));
            }
        }
        if stop.load(Ordering::Relaxed) { break; }
        if streamed {
            // End a phrase before switching/reopening devices. Failed retries add no audio.
            if io::stdout().write_all(&vec![0_u8; 16_000 * 4]).is_err() { break; }
            let _ = io::stdout().flush();
        }
        thread::sleep(Duration::from_millis(if streamed { 300 } else { 1000 }));
    }
}
