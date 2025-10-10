import runpod
import subprocess
import json
import sys
import os

def handler(event):
    """RunPod serverless handler that calls Node.js handler"""
    try:
        print(f"🚀 Python wrapper received event: {json.dumps(event, indent=2)}")
        
        # Call Node.js handler
        result = subprocess.run([
            'node', '-e', f'''
            import("./handler.js").then(module => {{
                const handler = module.default;
                handler({json.dumps(event)}).then(result => {{
                    console.log("RUNPOD_RESULT:" + JSON.stringify(result));
                }}).catch(error => {{
                    console.log("RUNPOD_ERROR:" + JSON.stringify({{
                        error: error.message,
                        stack: error.stack
                    }}));
                }});
            }}).catch(error => {{
                console.log("RUNPOD_ERROR:" + JSON.stringify({{
                    error: error.message,
                    stack: error.stack
                }}));
            }});
            '''
        ], capture_output=True, text=True, timeout=300)  # 5 minute timeout
        
        # Parse output
        stdout = result.stdout
        stderr = result.stderr
        
        print(f"Node.js stdout: {stdout}")
        if stderr:
            print(f"Node.js stderr: {stderr}")
        
        # Extract result from stdout
        for line in stdout.split('\n'):
            if line.startswith('RUNPOD_RESULT:'):
                result_json = line[14:]  # Remove "RUNPOD_RESULT:" prefix
                return json.loads(result_json)
            elif line.startswith('RUNPOD_ERROR:'):
                error_json = line[13:]  # Remove "RUNPOD_ERROR:" prefix
                error_data = json.loads(error_json)
                return {
                    "error": error_data.get("error", "Unknown error"),
                    "details": error_data.get("stack", "No stack trace")
                }
        
        # If no structured output found, return raw output
        return {
            "error": "No structured output from Node.js handler",
            "stdout": stdout,
            "stderr": stderr,
            "returncode": result.returncode
        }
        
    except subprocess.TimeoutExpired:
        return {"error": "Handler timeout (5 minutes exceeded)"}
    except Exception as e:
        return {
            "error": f"Python wrapper error: {str(e)}",
            "type": type(e).__name__
        }

if __name__ == "__main__":
    print("🎯 Starting RunPod serverless handler")
    print(f"Node.js version: {subprocess.check_output(['node', '--version']).decode().strip()}")
    print(f"Python version: {sys.version}")
    print(f"Working directory: {os.getcwd()}")
    print(f"GPU available: {os.environ.get('NVIDIA_VISIBLE_DEVICES', 'Not set')}")
    
    # Test handler locally first
    if len(sys.argv) > 1 and sys.argv[1] == 'test':
        print("\n🧪 Running local test...")
        test_event = {
            "input": {
                "action": "health"
            }
        }
        result = handler(test_event)
        print(f"Test result: {json.dumps(result, indent=2)}")
    else:
        # Start RunPod serverless
        print("🚀 Starting RunPod serverless...")
        runpod.serverless.start({"handler": handler})
