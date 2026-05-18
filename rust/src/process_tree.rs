// Used by macOS sidecar feature modules; default `--features tts` builds do
// not compile those call sites, but the helper still needs to stay shared.
#![allow(dead_code)]

use std::io;
use std::process::{Child, ChildStdin, ExitStatus, Output};

pub(crate) struct ChildGuard {
    child: Option<Child>,
}

impl ChildGuard {
    pub(crate) fn new(child: Child) -> Self {
        Self { child: Some(child) }
    }

    pub(crate) fn stdin_mut(&mut self) -> Option<&mut ChildStdin> {
        self.child.as_mut()?.stdin.as_mut()
    }

    pub(crate) fn close_stdin(&mut self) {
        if let Some(child) = self.child.as_mut() {
            drop(child.stdin.take());
        }
    }

    pub(crate) fn try_wait(&mut self) -> io::Result<Option<ExitStatus>> {
        self.child
            .as_mut()
            .expect("ChildGuard missing child")
            .try_wait()
    }

    pub(crate) fn wait_with_output(mut self) -> io::Result<Output> {
        self.child
            .take()
            .expect("ChildGuard missing child")
            .wait_with_output()
    }

    pub(crate) fn kill_and_wait_with_output(mut self) -> io::Result<Output> {
        if let Some(child) = self.child.as_mut() {
            let _ = child.kill();
        }
        self.wait_with_output()
    }
}

impl Drop for ChildGuard {
    fn drop(&mut self) {
        let Some(mut child) = self.child.take() else {
            return;
        };
        match child.try_wait() {
            Ok(Some(_)) => {}
            _ => {
                let _ = child.kill();
                let _ = child.wait();
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::process::{Command, Stdio};
    use std::time::{Duration, Instant};

    #[cfg(unix)]
    fn pid_is_alive(pid: u32) -> bool {
        Command::new("kill")
            .arg("-0")
            .arg(pid.to_string())
            .stdout(Stdio::null())
            .stderr(Stdio::null())
            .status()
            .map(|status| status.success())
            .unwrap_or(false)
    }

    #[cfg(unix)]
    fn wait_until_dead(pid: u32) -> bool {
        let started = Instant::now();
        while started.elapsed() < Duration::from_secs(2) {
            if !pid_is_alive(pid) {
                return true;
            }
            std::thread::sleep(Duration::from_millis(25));
        }
        false
    }

    #[cfg(unix)]
    #[test]
    fn drop_kills_unreaped_child() {
        let child = Command::new("sh")
            .arg("-c")
            .arg("trap '' TERM; while :; do sleep 1; done")
            .stdin(Stdio::null())
            .stdout(Stdio::null())
            .stderr(Stdio::null())
            .spawn()
            .expect("spawn helper");
        let pid = child.id();

        {
            let _guard = ChildGuard::new(child);
            assert!(pid_is_alive(pid));
        }

        assert!(wait_until_dead(pid), "child pid {pid} survived guard drop");
    }

    #[test]
    fn wait_with_output_disarms_drop_cleanup() {
        let child = Command::new("sh")
            .arg("-c")
            .arg("printf ok")
            .stdout(Stdio::piped())
            .stderr(Stdio::piped())
            .spawn()
            .expect("spawn helper");

        let output = ChildGuard::new(child).wait_with_output().expect("wait");
        assert!(output.status.success());
        assert_eq!(output.stdout, b"ok");
    }
}
