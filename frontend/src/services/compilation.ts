import axios from 'axios';

const API_BASE = import.meta.env.VITE_API_BASE || '/api';

export interface SketchFile {
  name: string;
  content: string;
}

export interface CompileResult {
  success: boolean;
  hex_content?: string;
  binary_content?: string;  // base64-encoded .bin for RP2040
  binary_type?: 'bin' | 'uf2';
  has_wifi?: boolean;        // True when sketch uses WiFi (ESP32 only)
  stdout: string;
  stderr: string;
  error?: string;
  core_install_log?: string;
}

export async function compileCode(
  files: SketchFile[],
  board: string = 'arduino:avr:uno'
): Promise<CompileResult> {
  try {
    console.log('Sending compilation request to:', `${API_BASE}/compile`);
    console.log('Board:', board);
    console.log('Files:', files.map((f) => f.name));

    const response = await axios.post<CompileResult>(
      `${API_BASE}/compile/`,
      { files, board_fqbn: board },
      { withCredentials: true }
    );

    console.log('Compilation response status:', response.status);
    return response.data;
  } catch (error) {
    console.error('Compilation request failed:', error);

    if (axios.isAxiosError(error)) {
      if (error.response) {
        console.error('Error response data:', error.response.data);
        return error.response.data;
      } else if (error.request) {
        throw new Error(
          'No response from server. Is the backend running on port 8001?'
        );
      }
    }

    throw error;
  }
}
