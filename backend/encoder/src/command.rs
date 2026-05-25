use crate::{CommandOutput, EncoderError};
use std::process::{Command, Stdio};

pub(crate) fn run_command_capture(
    name: &'static str,
    path: &str,
    args: &[String],
) -> Result<CommandOutput, EncoderError> {
    let output = Command::new(path)
        .args(args)
        .stdin(Stdio::null())
        .output()
        .map_err(|source| EncoderError::SpawnFailed {
            name,
            path: path.to_string(),
            source,
        })?;

    let stdout = String::from_utf8_lossy(&output.stdout).to_string();
    let stderr = String::from_utf8_lossy(&output.stderr).to_string();

    if !output.status.success() {
        return Err(EncoderError::CommandFailed {
            name,
            path: path.to_string(),
            args: args.to_vec(),
            status: output.status.code(),
            stderr,
        });
    }

    Ok(CommandOutput { stdout, stderr })
}

pub(crate) fn command_line(binary: &str, args: &[String]) -> String {
    let args = args
        .iter()
        .map(|arg| {
            if arg.chars().all(|character| {
                character.is_ascii_alphanumeric() || "-_./:=,%".contains(character)
            }) {
                arg.clone()
            } else {
                format!("'{}'", arg.replace('\'', "'\\''"))
            }
        })
        .collect::<Vec<_>>()
        .join(" ");
    format!("{binary} {args}")
}
