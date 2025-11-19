const fs = require('fs');
const path = require('path');

const buildDir = path.join(__dirname, '../keyboard-ui/build');
const targetDir = path.join(__dirname, '../static/keyboard-ui');

// Copy directory recursively
function copyDir(src, dest) {
    fs.mkdirSync(dest, { recursive: true });
    const entries = fs.readdirSync(src, { withFileTypes: true });

    for (const entry of entries) {
        const srcPath = path.join(src, entry.name);
        const destPath = path.join(dest, entry.name);

        if (entry.isDirectory()) {
            copyDir(srcPath, destPath);
        } else {
            fs.copyFileSync(srcPath, destPath);
        }
    }
}

// Rename hashed files to predictable names
function renameHashedFiles(dir) {
    const jsDir = path.join(dir, 'static/js');
    const cssDir = path.join(dir, 'static/css');

    // Rename JS files
    if (fs.existsSync(jsDir)) {
        const files = fs.readdirSync(jsDir);
        for (const file of files) {
            if (file.match(/^main\.[a-f0-9]+\.js$/)) {
                fs.renameSync(
                    path.join(jsDir, file),
                    path.join(jsDir, 'main.js')
                );
                console.log(`Renamed ${file} -> main.js`);
            }
            if (file.match(/^main\.[a-f0-9]+\.js\.map$/)) {
                fs.renameSync(
                    path.join(jsDir, file),
                    path.join(jsDir, 'main.js.map')
                );
                console.log(`Renamed ${file} -> main.js.map`);
            }
        }
    }

    // Rename CSS files
    if (fs.existsSync(cssDir)) {
        const files = fs.readdirSync(cssDir);
        for (const file of files) {
            if (file.match(/^main\.[a-f0-9]+\.css$/)) {
                fs.renameSync(
                    path.join(cssDir, file),
                    path.join(cssDir, 'main.css')
                );
                console.log(`Renamed ${file} -> main.css`);
            }
        }
    }
}

// Main execution
console.log('Copying keyboard-ui build to static directory...');

if (!fs.existsSync(buildDir)) {
    console.error('Error: keyboard-ui/build directory not found. Run npm run build in keyboard-ui first.');
    process.exit(1);
}

// Remove existing keyboard-ui static if it exists
if (fs.existsSync(targetDir)) {
    fs.rmSync(targetDir, { recursive: true });
    console.log('Removed existing static/keyboard-ui directory');
}

copyDir(buildDir, targetDir);
console.log('Copied build files to static/keyboard-ui/');

renameHashedFiles(targetDir);
console.log('Keyboard UI build complete!');
