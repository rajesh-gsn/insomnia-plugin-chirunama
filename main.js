const LABELARY_BASE_URL = 'https://api.labelary.com/v1/printers/8dpmm/labels';
const DOTS_PER_INCH = 203.2;
const MAX_PREVIEW_BYTES = 10 * 1024 * 1024;
const MAX_ENCODED_PREVIEW_BYTES = Math.ceil(MAX_PREVIEW_BYTES * 4 / 3) + 1024;

function hasSignature(body, signature) {
	return body.length >= signature.length && body.subarray(0, signature.length).equals(signature);
}

function detectFormat(contentType, body) {
	const normalizedType = (Array.isArray(contentType) ? contentType.join(';') : contentType || '')
		.split(';', 1)[0]
		.trim()
		.toLowerCase();

	if (normalizedType === 'image/png' || hasSignature(body, Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) {
		return 'png';
	}

	if (normalizedType === 'application/pdf' || body.subarray(0, 1024).includes(Buffer.from('%PDF-'))) {
		return 'pdf';
	}

	const text = body.toString('utf8').replace(/^\uFEFF/, '').trimStart();
	if (normalizedType.includes('zpl') || (text.includes('^XA') && text.includes('^XZ'))) {
		return 'zpl';
	}

	return null;
}

function stripBase64Padding(value) {
	if (value.endsWith('==')) {
		return value.slice(0, -2);
	}
	if (value.endsWith('=')) {
		return value.slice(0, -1);
	}
	return value;
}

function decodeBase64Response(body) {
	let text = body.toString('utf8').replace(/^\uFEFF/, '').trim();
	let contentType = null;
	const dataUri = text.match(/^data:([^;,]+);base64,([\s\S]*)$/i);

	if (dataUri) {
		contentType = dataUri[1].toLowerCase();
		text = dataUri[2];
	} else if (text.startsWith('"') && text.endsWith('"')) {
		try {
			text = JSON.parse(text);
		} catch {
			return null;
		}
	}

	const encoded = text.replace(/\s/g, '');
	if (encoded.length < 8 || encoded.length % 4 === 1 || !/^[A-Za-z0-9+/]*={0,2}$/.test(encoded)) {
		return null;
	}

	const decoded = Buffer.from(encoded, 'base64');
	const canonical = decoded.toString('base64');
	const canonicalWithoutPadding = stripBase64Padding(canonical);
	const encodedWithoutPadding = stripBase64Padding(encoded);
	if (canonicalWithoutPadding !== encodedWithoutPadding) {
		return null;
	}

	return { body: decoded, contentType };
}

function previewsForFormat(format, body) {
	if (format === 'zpl') {
		return splitZplLabels(body);
	}

	return format ? [{ format, body }] : [];
}

function getPreviewsFromPayload(contentType, body) {
	const decoded = decodeBase64Response(body);
	if (decoded) {
		return previewsForFormat(detectFormat(decoded.contentType || contentType, decoded.body), decoded.body);
	}

	return previewsForFormat(detectFormat(contentType, body), body);
}

function splitZplLabels(body) {
	const zpl = body.toString('utf8').replace(/^\uFEFF/, '').trim();
	const labels = zpl.match(/\^XA[\s\S]*?\^XZ/gi);
	if (!labels || labels.length < 2) {
		return [{ format: 'zpl', body }];
	}

	const preamble = zpl.slice(0, zpl.search(/\^XA/i));
	return labels.map(label => ({
		format: 'zpl',
		body: Buffer.from(inheritPreambleSize(preamble, label), 'utf8'),
	}));
}

function inheritPreambleSize(preamble, label) {
	const inherited = ['PW', 'LL'].flatMap(command => {
		const match = preamble.match(new RegExp(`\\^${command}\\d+`, 'i'));
		return match && !new RegExp(`\\^${command}\\d+`, 'i').test(label) ? [match[0]] : [];
	});

	return inherited.length > 0 ? `${inherited.join('\n')}\n${label}` : label;
}

function pushJsonChildren(pending, value) {
	const values = Array.isArray(value) ? value : Object.values(value);
	for (let index = values.length - 1; index >= 0; index--) {
		pending.push(values[index]);
	}
}

function limitPreviews(previews) {
	const accepted = [];
	let bytes = 0;

	for (const preview of previews) {
		if (bytes + preview.body.length > MAX_PREVIEW_BYTES) {
			break;
		}

		bytes += preview.body.length;
		accepted.push(preview);
	}

	return accepted;
}

function findPreviewsInJson(contentType, value) {
	const pending = [value];
	const found = [];
	let visited = 0;
	let bytes = 0;

	while (pending.length > 0 && visited < 100000) {
		const current = pending.pop();
		visited++;
		if (typeof current === 'string') {
			for (const preview of getPreviewsFromPayload(contentType, Buffer.from(current))) {
				if (bytes + preview.body.length > MAX_PREVIEW_BYTES) {
					return found;
				}

				bytes += preview.body.length;
				found.push(preview);
			}
			continue;
		}

		if (current && typeof current === 'object') {
			pushJsonChildren(pending, current);
		}
	}

	return found;
}

function getPreviewData(contentType, body) {
	const text = body.toString('utf8').replace(/^\uFEFF/, '').trimStart();
	if (text.startsWith('{') || text.startsWith('[') || text.startsWith('"')) {
		try {
			return findPreviewsInJson(contentType, JSON.parse(text));
		} catch {
			return [];
		}
	}

	return limitPreviews(getPreviewsFromPayload(contentType, body));
}

function getLabelDimension(zpl, command, fallback) {
	const match = zpl.match(command);
	if (!match) {
		return fallback;
	}

	const inches = Number(match[1]) / DOTS_PER_INCH;
	return Number.isFinite(inches) && inches > 0 ? Math.min(Math.round(inches * 100) / 100, 30) : fallback;
}

function jsonForScript(value) {
	return JSON.stringify(value)
		.replace(/</g, '\\u003c')
		.replace(/\u2028/g, '\\u2028')
		.replace(/\u2029/g, '\\u2029');
}

function describePreview(item, index, total) {
	const suffix = total > 1 ? `-${index + 1}` : '';
	if (item.format === 'zpl') {
		const zpl = item.body.toString('utf8').replace(/^\uFEFF/, '').trim();
		const width = getLabelDimension(zpl, /\^PW(\d+)/i, 4);
		const height = getLabelDimension(zpl, /\^LL(\d+)/i, 6);
		return {
			kind: 'zpl',
			endpoint: `${LABELARY_BASE_URL}/${width}x${height}/0/?${encodeURIComponent(zpl)}`,
			fileName: `label${suffix}.png`,
			title: 'Label Preview',
		};
	}

	const pdf = item.format === 'pdf';
	return {
		kind: pdf ? 'pdf' : 'png',
		src: `data:${pdf ? 'application/pdf' : 'image/png'};base64,${item.body.toString('base64')}`,
		fileName: `response${suffix}.${pdf ? 'pdf' : 'png'}`,
		title: 'Label Preview',
	};
}

function initialMarkup(descriptor) {
	const image = descriptor.kind === 'png'
		? `<img id="preview" src="${descriptor.src}" alt="PNG response">`
		: '<img id="preview" alt="Rendered ZPL label" hidden>';
	const frame = descriptor.kind === 'pdf'
		? `<iframe id="pdf" title="PDF response" src="${descriptor.src}"></iframe>`
		: '<iframe id="pdf" title="PDF response" hidden></iframe>';
	const download = descriptor.kind === 'zpl'
		? '<a id="download" class="button" aria-disabled="true">Rendering label...</a>'
		: `<a id="download" class="button" href="${descriptor.src}" download="${descriptor.fileName}">Download ${descriptor.kind === 'pdf' ? 'PDF' : 'PNG'}</a>`;

	return {
		image,
		frame,
		download,
		status: descriptor.kind === 'zpl' ? 'Rendering label...' : '',
	};
}

function previewScript(descriptors) {
	return `
		const items = ${jsonForScript(descriptors)};
		let index = 0;
		const rendered = new Map();
		const image = document.getElementById('preview');
		const pdf = document.getElementById('pdf');
		const download = document.getElementById('download');
		const status = document.getElementById('status');
		const title = document.getElementById('title');
		const position = document.getElementById('position');
		const prev = document.getElementById('prev');
		const next = document.getElementById('next');

		function setDownload(href, fileName, label) {
			if (href) {
				download.href = href;
				download.download = fileName;
				download.removeAttribute('aria-disabled');
				download.textContent = label;
			} else {
				download.removeAttribute('href');
				download.setAttribute('aria-disabled', 'true');
				download.textContent = label;
			}
		}

		function showImage(url, item) {
			pdf.hidden = true;
			image.hidden = false;
			image.alt = item.kind === 'zpl' ? 'Rendered ZPL label' : 'PNG response';
			image.src = url;
			setDownload(url, item.fileName, 'Download PNG');
			status.textContent = '';
		}

		function show(nextIndex) {
			index = nextIndex;
			const item = items[index];
			title.textContent = item.title;
			document.title = item.title;
			if (position) {
				position.textContent = (index + 1) + ' / ' + items.length;
			}
			if (prev) {
				prev.disabled = index === 0;
			}
			if (next) {
				next.disabled = index === items.length - 1;
			}

			if (item.kind === 'pdf') {
				image.hidden = true;
				pdf.hidden = false;
				pdf.src = item.src;
				setDownload(item.src, item.fileName, 'Download PDF');
				status.textContent = '';
				return;
			}

			if (item.kind === 'png') {
				showImage(item.src, item);
				return;
			}

			const cached = rendered.get(index);
			if (cached) {
				showImage(cached, item);
				return;
			}

			image.hidden = true;
			pdf.hidden = true;
			setDownload('', item.fileName, 'Rendering label...');
			status.textContent = 'Rendering label...';
			const requested = index;
			fetch(item.endpoint).then(response => {
				if (!response.ok) {
					throw new Error('Labelary returned HTTP ' + response.status);
				}
				return response.blob();
			}).then(blob => {
				const imageUrl = URL.createObjectURL(blob);
				rendered.set(requested, imageUrl);
				if (index === requested) {
					showImage(imageUrl, item);
				}
			}).catch(error => {
				if (index === requested) {
					status.textContent = 'Could not render label: ' + error.message;
				}
			});
		}

		function move(step) {
			const nextIndex = index + step;
			if (nextIndex >= 0 && nextIndex < items.length) {
				show(nextIndex);
			}
		}

		if (prev) {
			prev.addEventListener('click', () => move(-1));
		}
		if (next) {
			next.addEventListener('click', () => move(1));
		}
		document.addEventListener('keydown', event => {
			if (event.key === 'ArrowLeft') {
				event.preventDefault();
				move(-1);
			} else if (event.key === 'ArrowRight') {
				event.preventDefault();
				move(1);
			}
		});

		if (items[0] && items[0].kind === 'zpl') {
			show(0);
		}
	`;
}

const THEME_VARIABLES = [
	'--color-bg',
	'--color-font',
	'--color-font-rgb',
	'--color-success',
	'--color-font-success',
	'--color-notice',
	'--color-font-notice',
	'--color-warning',
	'--color-font-warning',
	'--color-danger',
	'--color-font-danger',
	'--color-info',
	'--color-font-info',
	'--color-surprise',
	'--color-font-surprise',
	'--hl',
	'--hl-xxs',
	'--hl-xs',
	'--hl-sm',
	'--hl-md',
	'--hl-lg',
	'--hl-xl',
	'--font-default',
	'--font-size',
	'--font-size-md',
	'--radius-sm',
	'--radius-md',
	'--opacity-subtle',
	'--opacity-super-subtle',
	'--padding-md',
];

function readStyleVariables(element) {
	const styles = getComputedStyle(element);
	const variables = {};
	for (let index = 0; index < styles.length; index++) {
		const name = styles.item(index);
		if (name && name.startsWith('--')) {
			const value = styles.getPropertyValue(name).trim();
			if (value && value.length <= 500) {
				variables[name] = value;
			}
		}
	}

	for (const name of THEME_VARIABLES) {
		const value = styles.getPropertyValue(name).trim();
		if (value && value.length <= 500) {
			variables[name] = value;
		}
	}

	return { styles, variables };
}

function colorSchemeFor(color) {
	let red;
	let green;
	let blue;
	const rgb = typeof color === 'string' && color.match(/rgba?\(\s*([\d.]+)[\s,]+([\d.]+)[\s,]+([\d.]+)/i);
	const hex = typeof color === 'string' && color.match(/^#([0-9a-f]{6})$/i);
	const shortHex = typeof color === 'string' && color.match(/^#([0-9a-f]{3})$/i);
	if (rgb) {
		red = Number(rgb[1]);
		green = Number(rgb[2]);
		blue = Number(rgb[3]);
	} else if (hex) {
		red = parseInt(hex[1].slice(0, 2), 16);
		green = parseInt(hex[1].slice(2, 4), 16);
		blue = parseInt(hex[1].slice(4, 6), 16);
	} else if (shortHex) {
		red = parseInt(shortHex[1][0] + shortHex[1][0], 16);
		green = parseInt(shortHex[1][1] + shortHex[1][1], 16);
		blue = parseInt(shortHex[1][2] + shortHex[1][2], 16);
	} else {
		return 'light';
	}

	const luminance = (0.2126 * red + 0.7152 * green + 0.0722 * blue) / 255;
	return luminance < 0.55 ? 'dark' : 'light';
}

function safeCssValue(value) {
	return typeof value === 'string' && value.trim() && value.length <= 500 && !/[<>{};]|[\u0000-\u001f\\]/.test(value)
		? value.trim()
		: null;
}

const INSOMNIA_FONT = '-apple-system, BlinkMacSystemFont, "Segoe WPC", "Segoe UI", "HelveticaNeue-Light", Ubuntu, "Droid Sans", sans-serif';
const BUILTIN_THEMES = {
	"colorblind-dark": {
		"--color-bg": "#21262D",
		"--color-success": "#0080FF",
		"--color-notice": "#E8F086",
		"--color-warning": "#A691AE",
		"--color-danger": "#CC5500",
		"--color-surprise": "#FFC20A",
		"--color-info": "#58A6FF",
		"--color-font": "#fff",
		"--color-font-success": "#000",
		"--color-font-notice": "#000",
		"--color-font-warning": "#fff",
		"--color-font-danger": "#fff",
		"--color-font-surprise": "#000",
		"--color-font-info": "#000",
		"--hl": "#D3D3D3",
		"--hl-xxs": "rgba(130, 130, 130, 0.05)",
		"--hl-xs": "rgba(130, 130, 130, 0.1)",
		"--hl-sm": "rgba(130, 130, 130, 0.25)",
		"--hl-md": "rgba(130, 130, 130, 0.35)",
		"--hl-lg": "rgba(130, 130, 130, 0.5)",
		"--hl-xl": "rgba(130, 130, 130, 0.8)"
	},
	"default": {
		"--color-bg": "#2C2C2C",
		"--color-success": "#7ecf2b",
		"--color-notice": "#f0e137",
		"--color-warning": "#ff9a1f",
		"--color-danger": "#ff5631",
		"--color-surprise": "#a896ff",
		"--color-info": "#46c1e6",
		"--color-font": "#ddd",
		"--color-font-success": "#fff",
		"--color-font-notice": "#fff",
		"--color-font-warning": "#fff",
		"--color-font-danger": "#fff",
		"--color-font-surprise": "#fff",
		"--color-font-info": "#fff",
		"--hl": "rgba(130, 130, 130, 1)",
		"--hl-xxs": "rgba(130, 130, 130, 0.05)",
		"--hl-xs": "rgba(130, 130, 130, 0.1)",
		"--hl-sm": "rgba(130, 130, 130, 0.25)",
		"--hl-md": "rgba(130, 130, 130, 0.35)",
		"--hl-lg": "rgba(130, 130, 130, 0.5)",
		"--hl-xl": "rgba(130, 130, 130, 0.8)"
	},
	"gruvbox-dark": {
		"--color-bg": "#282828",
		"--color-success": "#83a598",
		"--color-notice": "#b8bb26",
		"--color-warning": "#d79921",
		"--color-danger": "#eb5746",
		"--color-surprise": "#d3869b",
		"--color-info": "#83a598",
		"--color-font": "#d9d1ce",
		"--color-font-success": "#fff",
		"--color-font-notice": "#fff",
		"--color-font-warning": "#fff",
		"--color-font-danger": "#fff",
		"--color-font-surprise": "#fff",
		"--color-font-info": "#fff",
		"--hl": "rgb(140, 135, 131)",
		"--hl-xxs": "rgba(140, 135, 131, 0.05)",
		"--hl-xs": "rgba(140, 135, 131, 0.1)",
		"--hl-sm": "rgba(140, 135, 131, 0.2)",
		"--hl-md": "rgba(140, 135, 131, 0.4)",
		"--hl-lg": "rgba(140, 135, 131, 0.6)",
		"--hl-xl": "rgba(140, 135, 131, 0.8)"
	},
	"high-contrast-light": {
		"--color-bg": "#ffffff",
		"--color-success": "#000",
		"--color-notice": "#000",
		"--color-warning": "#000",
		"--color-danger": "#000",
		"--color-surprise": "#000",
		"--color-info": "#000",
		"--color-font": "#000",
		"--color-font-success": "#fff",
		"--color-font-notice": "#fff",
		"--color-font-warning": "#fff",
		"--color-font-danger": "#fff",
		"--color-font-surprise": "#fff",
		"--color-font-info": "#fff",
		"--hl": "rgb(80, 80, 80)",
		"--hl-xxs": "rgba(80, 80, 80, 0.1)",
		"--hl-xs": "rgba(80, 80, 80, 0.3)",
		"--hl-sm": "rgba(80, 80, 80, 0.4)",
		"--hl-md": "rgba(80, 80, 80, 0.5)",
		"--hl-lg": "rgba(80, 80, 80, 0.6)",
		"--hl-xl": "rgba(80, 80, 80, 0.9)"
	},
	"hyper": {
		"--color-bg": "#000",
		"--color-success": "#87ee59",
		"--color-notice": "#f8d245",
		"--color-warning": "#f9ac2a",
		"--color-danger": "#ff505c",
		"--color-surprise": "#f24aff",
		"--color-info": "#23dce8",
		"--color-font": "#ddd",
		"--color-font-success": "#fff",
		"--color-font-notice": "#fff",
		"--color-font-warning": "#fff",
		"--color-font-danger": "#fff",
		"--color-font-surprise": "#fff",
		"--color-font-info": "#fff",
		"--hl": "rgba(130, 130, 130, 1)",
		"--hl-xxs": "rgba(130, 130, 130, 0.05)",
		"--hl-xs": "rgba(130, 130, 130, 0.1)",
		"--hl-sm": "rgba(130, 130, 130, 0.25)",
		"--hl-md": "rgba(130, 130, 130, 0.35)",
		"--hl-lg": "rgba(130, 130, 130, 0.5)",
		"--hl-xl": "rgba(130, 130, 130, 0.8)"
	},
	"legacy": {
		"--color-bg": "#2C2C2C",
		"--color-success": "#7ecf2b",
		"--color-notice": "#f0e137",
		"--color-warning": "#ff9a1f",
		"--color-danger": "#ff5631",
		"--color-surprise": "#a896ff",
		"--color-info": "#46c1e6",
		"--color-font": "#eee",
		"--color-font-success": "#fff",
		"--color-font-notice": "#fff",
		"--color-font-warning": "#fff",
		"--color-font-danger": "#fff",
		"--color-font-surprise": "#fff",
		"--color-font-info": "#fff",
		"--hl": "rgba(130, 130, 130, 1)",
		"--hl-xxs": "rgba(130, 130, 130, 0.05)",
		"--hl-xs": "rgba(130, 130, 130, 0.1)",
		"--hl-sm": "rgba(130, 130, 130, 0.25)",
		"--hl-md": "rgba(130, 130, 130, 0.35)",
		"--hl-lg": "rgba(130, 130, 130, 0.5)",
		"--hl-xl": "rgba(130, 130, 130, 0.8)"
	},
	"material": {
		"--color-bg": "#263238",
		"--color-success": "#80cbc4",
		"--color-notice": "#ffcb6b",
		"--color-warning": "#f77669",
		"--color-danger": "#ff5370",
		"--color-surprise": "#c792ea",
		"--color-info": "#82b1ff",
		"--color-font": "#dde1e1",
		"--color-font-success": "#fff",
		"--color-font-notice": "#fff",
		"--color-font-warning": "#fff",
		"--color-font-danger": "#fff",
		"--color-font-surprise": "#fff",
		"--color-font-info": "#fff",
		"--hl": "rgba(114, 145, 143, 1)",
		"--hl-xxs": "rgba(114, 145, 143, 0.05)",
		"--hl-xs": "rgba(114, 145, 143, 0.1)",
		"--hl-sm": "rgba(114, 145, 143, 0.15)",
		"--hl-md": "rgba(114, 145, 143, 0.2)",
		"--hl-lg": "rgba(114, 145, 143, 0.5)",
		"--hl-xl": "rgba(114, 145, 143, 0.8)"
	},
	"one-dark": {
		"--color-bg": "#272c35",
		"--color-success": "#98c379",
		"--color-notice": "#e3a96c",
		"--color-warning": "#d19a66",
		"--color-danger": "#e06c75",
		"--color-surprise": "#c678dd",
		"--color-info": "#56b6c2",
		"--color-font": "#bbb",
		"--color-font-success": "#fff",
		"--color-font-notice": "#fff",
		"--color-font-warning": "#fff",
		"--color-font-danger": "#fff",
		"--color-font-surprise": "#fff",
		"--color-font-info": "#fff",
		"--hl": "rgba(114, 121, 133, 1)",
		"--hl-xxs": "rgba(114, 121, 133, 0.05)",
		"--hl-xs": "rgba(114, 121, 133, 0.1)",
		"--hl-sm": "rgba(114, 121, 133, 0.2)",
		"--hl-md": "rgba(114, 121, 133, 0.4)",
		"--hl-lg": "rgba(114, 121, 133, 0.6)",
		"--hl-xl": "rgba(114, 121, 133, 0.8)"
	},
	"one-light": {
		"--color-bg": "#fafafa",
		"--color-success": "#50a14f",
		"--color-notice": "#c18401",
		"--color-warning": "#c18401",
		"--color-danger": "#e45649",
		"--color-surprise": "#a626a4",
		"--color-info": "#0184bc",
		"--color-font": "#777",
		"--color-font-success": "#fff",
		"--color-font-notice": "#fff",
		"--color-font-warning": "#fff",
		"--color-font-danger": "#fff",
		"--color-font-surprise": "#fff",
		"--color-font-info": "#fff",
		"--hl": "rgba(114, 121, 133, 1)",
		"--hl-xxs": "rgba(114, 121, 133, 0.05)",
		"--hl-xs": "rgba(114, 121, 133, 0.1)",
		"--hl-sm": "rgba(114, 121, 133, 0.2)",
		"--hl-md": "rgba(114, 121, 133, 0.3)",
		"--hl-lg": "rgba(114, 121, 133, 0.5)",
		"--hl-xl": "rgba(114, 121, 133, 0.8)"
	},
	"purple": {
		"--color-bg": "#fff",
		"--color-success": "#75ba24",
		"--color-notice": "#d8c84d",
		"--color-warning": "#ec8702",
		"--color-danger": "#e15251",
		"--color-surprise": "#6030BF",
		"--color-info": "#20aed9",
		"--color-font": "#555",
		"--color-font-success": "#fff",
		"--color-font-notice": "#fff",
		"--color-font-warning": "#fff",
		"--color-font-danger": "#fff",
		"--color-font-surprise": "#fff",
		"--color-font-info": "#fff",
		"--hl": "rgba(130, 130, 130, 1)",
		"--hl-xxs": "rgba(130, 130, 130, 0.05)",
		"--hl-xs": "rgba(130, 130, 130, 0.1)",
		"--hl-sm": "rgba(130, 130, 130, 0.25)",
		"--hl-md": "rgba(130, 130, 130, 0.35)",
		"--hl-lg": "rgba(130, 130, 130, 0.5)",
		"--hl-xl": "rgba(130, 130, 130, 0.8)"
	},
	"railscasts": {
		"--color-bg": "#2b2b2b",
		"--color-success": "#a5c261",
		"--color-notice": "#ffc66d",
		"--color-warning": "#e48a37",
		"--color-danger": "#ee4b3b",
		"--color-surprise": "#b6b3eb",
		"--color-info": "#6d9cbe",
		"--color-font": "#ddd",
		"--color-font-success": "#fff",
		"--color-font-notice": "#fff",
		"--color-font-warning": "#fff",
		"--color-font-danger": "#fff",
		"--color-font-surprise": "#fff",
		"--color-font-info": "#fff",
		"--hl": "rgba(130, 130, 130, 1)",
		"--hl-xxs": "rgba(130, 130, 130, 0.05)",
		"--hl-xs": "rgba(130, 130, 130, 0.1)",
		"--hl-sm": "rgba(130, 130, 130, 0.25)",
		"--hl-md": "rgba(130, 130, 130, 0.35)",
		"--hl-lg": "rgba(130, 130, 130, 0.5)",
		"--hl-xl": "rgba(130, 130, 130, 0.8)"
	},
	"dark": {
		"--color-bg": "#222",
		"--color-success": "#8fc860",
		"--color-notice": "#e5ca1e",
		"--color-warning": "#f9a230",
		"--color-danger": "#f06d6b",
		"--color-surprise": "#aca0f2",
		"--color-info": "#6eccec",
		"--color-font": "#ddd",
		"--color-font-success": "#fff",
		"--color-font-notice": "#fff",
		"--color-font-warning": "#fff",
		"--color-font-danger": "#fff",
		"--color-font-surprise": "#fff",
		"--color-font-info": "#fff",
		"--hl": "rgba(130, 130, 130, 1)",
		"--hl-xxs": "rgba(130, 130, 130, 0.05)",
		"--hl-xs": "rgba(130, 130, 130, 0.1)",
		"--hl-sm": "rgba(130, 130, 130, 0.25)",
		"--hl-md": "rgba(130, 130, 130, 0.35)",
		"--hl-lg": "rgba(130, 130, 130, 0.5)",
		"--hl-xl": "rgba(130, 130, 130, 0.8)"
	},
	"light": {
		"--color-bg": "#fff",
		"--color-success": "#75ba24",
		"--color-notice": "#d8c84d",
		"--color-warning": "#ec8702",
		"--color-danger": "#e15251",
		"--color-surprise": "#6030BF",
		"--color-info": "#20aed9",
		"--color-font": "#666",
		"--color-font-success": "#fff",
		"--color-font-notice": "#fff",
		"--color-font-warning": "#fff",
		"--color-font-danger": "#fff",
		"--color-font-surprise": "#fff",
		"--color-font-info": "#fff",
		"--hl": "rgba(130, 130, 130, 1)",
		"--hl-xxs": "rgba(130, 130, 130, 0.05)",
		"--hl-xs": "rgba(130, 130, 130, 0.1)",
		"--hl-sm": "rgba(130, 130, 130, 0.25)",
		"--hl-md": "rgba(130, 130, 130, 0.35)",
		"--hl-lg": "rgba(130, 130, 130, 0.5)",
		"--hl-xl": "rgba(130, 130, 130, 0.8)"
	},
	"solarized": {
		"--color-bg": "#fdf6e3",
		"--color-success": "#859900",
		"--color-notice": "#b58900",
		"--color-warning": "#cb4b16",
		"--color-danger": "#dc322f",
		"--color-surprise": "#6c71c4",
		"--color-info": "#2aa198",
		"--color-font": "#556970",
		"--color-font-success": "#fff",
		"--color-font-notice": "#fff",
		"--color-font-warning": "#fff",
		"--color-font-danger": "#fff",
		"--color-font-surprise": "#fff",
		"--color-font-info": "#fff",
		"--hl": "rgb(142, 149, 146)",
		"--hl-xxs": "rgba(159, 167, 164, 0.05)",
		"--hl-xs": "rgba(159, 167, 164, 0.1)",
		"--hl-sm": "rgba(159, 167, 164, 0.2)",
		"--hl-md": "rgba(142, 149, 146, 0.3)",
		"--hl-lg": "rgba(142, 149, 146, 0.6)",
		"--hl-xl": "rgba(142, 149, 146, 0.8)"
	},
	"solarized-dark": {
		"--color-bg": "#002b36",
		"--color-success": "#859900",
		"--color-notice": "#b58900",
		"--color-warning": "#cb4b16",
		"--color-danger": "#dc322f",
		"--color-surprise": "#6c71c4",
		"--color-info": "#2aa198",
		"--color-font": "#839496",
		"--color-font-success": "#fff",
		"--color-font-notice": "#fff",
		"--color-font-warning": "#fff",
		"--color-font-danger": "#fff",
		"--color-font-surprise": "#fff",
		"--color-font-info": "#fff",
		"--hl": "rgb(142, 149, 146)",
		"--hl-xxs": "rgba(159, 167, 164, 0.05)",
		"--hl-xs": "rgba(159, 167, 164, 0.1)",
		"--hl-sm": "rgba(159, 167, 164, 0.2)",
		"--hl-md": "rgba(142, 149, 146, 0.3)",
		"--hl-lg": "rgba(142, 149, 146, 0.6)",
		"--hl-xl": "rgba(142, 149, 146, 0.8)"
	},
	"solarized-light": {
		"--color-bg": "#fdf6e3",
		"--color-success": "#859900",
		"--color-notice": "#b58900",
		"--color-warning": "#cb4b16",
		"--color-danger": "#dc322f",
		"--color-surprise": "#6c71c4",
		"--color-info": "#2aa198",
		"--color-font": "#657b83",
		"--color-font-success": "#fff",
		"--color-font-notice": "#fff",
		"--color-font-warning": "#fff",
		"--color-font-danger": "#fff",
		"--color-font-surprise": "#fff",
		"--color-font-info": "#fff",
		"--hl": "rgb(142, 149, 146)",
		"--hl-xxs": "rgba(159, 167, 164, 0.05)",
		"--hl-xs": "rgba(159, 167, 164, 0.1)",
		"--hl-sm": "rgba(159, 167, 164, 0.2)",
		"--hl-md": "rgba(142, 149, 146, 0.3)",
		"--hl-lg": "rgba(142, 149, 146, 0.6)",
		"--hl-xl": "rgba(142, 149, 146, 0.8)"
	},
	"studio-colorful": {
		"--color-bg": "#003052",
		"--color-success": "#69c790",
		"--color-notice": "#edcb02",
		"--color-warning": "#e89c42",
		"--color-danger": "#ef6e6e",
		"--color-surprise": "#bfa3f9",
		"--color-info": "#6ac7e6",
		"--color-font": "#e6eff5",
		"--color-font-success": "#fff",
		"--color-font-notice": "#fff",
		"--color-font-warning": "#fff",
		"--color-font-danger": "#fff",
		"--color-font-surprise": "#fff",
		"--color-font-info": "#fff",
		"--hl": "rgba(133, 157, 176)",
		"--hl-xxs": "rgba(133, 157, 176, 0.05)",
		"--hl-xs": "rgba(133, 157, 176, 0.1)",
		"--hl-sm": "rgba(133, 157, 176, 0.2)",
		"--hl-md": "rgba(133, 157, 176, 0.3)",
		"--hl-lg": "rgba(133, 157, 176, 0.5)",
		"--hl-xl": "rgba(133, 157, 176, 0.8)"
	},
	"studio-light": {
		"--color-bg": "#fff",
		"--color-success": "#3d9c62",
		"--color-notice": "#bb9700",
		"--color-warning": "#d6803e",
		"--color-danger": "#da5b56",
		"--color-surprise": "#6030BF",
		"--color-info": "#003052",
		"--color-font": "#555",
		"--color-font-success": "#fff",
		"--color-font-notice": "#fff",
		"--color-font-warning": "#fff",
		"--color-font-danger": "#fff",
		"--color-font-surprise": "#fff",
		"--color-font-info": "#fff",
		"--hl": "rgba(130, 130, 130, 1)",
		"--hl-xxs": "rgba(130, 130, 130, 0.05)",
		"--hl-xs": "rgba(130, 130, 130, 0.1)",
		"--hl-sm": "rgba(130, 130, 130, 0.25)",
		"--hl-md": "rgba(130, 130, 130, 0.35)",
		"--hl-lg": "rgba(130, 130, 130, 0.5)",
		"--hl-xl": "rgba(130, 130, 130, 0.8)"
	}
};

function readDocumentTheme() {
	if (typeof document === 'undefined' || typeof getComputedStyle !== 'function' || !document.documentElement) {
		return null;
	}

	const themed = document.querySelector('[theme]') || document.documentElement;
	const variables = {
		...readStyleVariables(document.documentElement).variables,
		...readStyleVariables(themed).variables,
	};
	if (!variables['--color-bg']) {
		return null;
	}

	const styles = getComputedStyle(themed);
	const fontSize = /^\d+(\.\d+)?px$/.test(styles.fontSize) ? styles.fontSize : null;
	const colorScheme = styles.colorScheme === 'dark' || styles.colorScheme === 'light'
		? styles.colorScheme
		: colorSchemeFor(variables['--color-bg']);

	return {
		variables,
		fontFamily: safeCssValue(styles.fontFamily),
		fontSize,
		colorScheme,
	};
}

function activeThemeName(settings) {
	if (settings.autoDetectColorScheme && typeof matchMedia === 'function') {
		if (matchMedia('(prefers-color-scheme: light)').matches && settings.lightTheme) {
			return settings.lightTheme;
		}
		if (matchMedia('(prefers-color-scheme: dark)').matches && settings.darkTheme) {
			return settings.darkTheme;
		}
	}

	return settings.theme || settings.darkTheme || 'default';
}

function themeFromSettings(settings) {
	const variables = BUILTIN_THEMES[activeThemeName(settings)];
	if (!variables) {
		return null;
	}

	const fontSize = Number(settings.fontSize);
	return {
		variables,
		fontFamily: safeCssValue(settings.fontInterface) || INSOMNIA_FONT,
		fontSize: Number.isFinite(fontSize) && fontSize > 0 ? `${fontSize}px` : '13px',
		colorScheme: colorSchemeFor(variables['--color-bg']),
	};
}

async function readInsomniaTheme(context) {
	try {
		const getSettings = context && context.util && context.util.models && context.util.models.settings && context.util.models.settings.get;
		if (typeof getSettings === 'function') {
			const settings = await getSettings();
			const theme = settings && themeFromSettings(settings);
			if (theme) {
				return theme;
			}
		}
	} catch (error) {
		console.warn('Could not read Insomnia theme settings', error);
	}

	return readDocumentTheme();
}

function themeStyle(theme) {
	if (!theme) {
		return '';
	}

	const declarations = [`color-scheme: ${theme.colorScheme === 'dark' ? 'dark' : 'light'}`];
	if (theme.fontFamily) {
		declarations.push(`font-family: ${theme.fontFamily}`);
	}
	if (theme.fontSize) {
		declarations.push(`font-size: ${theme.fontSize}`);
	}
	for (const [name, value] of Object.entries(theme.variables || {})) {
		const safeValue = safeCssValue(value);
		if (/^--[a-z0-9-]+$/i.test(name) && safeValue) {
			declarations.push(`${name}: ${safeValue}`);
		}
	}

	return `:root { ${declarations.join('; ')}; }`;
}

function previewPage(items, theme) {
	const descriptors = items.map((item, index) => describePreview(item, index, items.length));
	const first = descriptors[0];
	const initial = initialMarkup(first);
	const nav = descriptors.length > 1 ? `
			<div class="nav">
				<button type="button" class="icon-button" id="prev" aria-label="Previous label" disabled>←</button>
				<span id="position" aria-live="polite">1 / ${descriptors.length}</span>
				<button type="button" class="icon-button" id="next" aria-label="Next label">→</button>
			</div>` : '';

	return `<!doctype html>
	<html lang="en">
	<head>
		<meta charset="utf-8">
		<meta name="viewport" content="width=device-width, initial-scale=1">
		<title>${first.title}</title>
		<style>
			:root { color-scheme: light; font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif; font-size: 14px; }
			${themeStyle(theme)}
			body { margin: 0; min-height: 100vh; display: flex; flex-direction: column; background: var(--color-bg, #f3f4f6); color: var(--color-font, #20242a); font-family: inherit; font-size: inherit; }
			header { display: flex; align-items: center; justify-content: space-between; gap: 16px; flex-wrap: wrap; padding: var(--padding-md, 14px) 20px; background: var(--color-bg, #fff); border-bottom: 1px solid var(--hl-md, #d9dde3); }
			h1 { margin: 0; font-size: var(--font-size-lg, 16px); font-weight: 600; }
			.toolbar { display: flex; align-items: center; gap: 10px; }
			.nav { display: flex; align-items: center; gap: 8px; }
			.icon-button { width: 34px; height: 34px; padding: 0; border: 1px solid var(--hl-md, #d9dde3); border-radius: var(--radius-sm, 4px); background: var(--color-bg, #fff); color: var(--color-font, #20242a); font-size: 18px; line-height: 1; cursor: pointer; }
			.icon-button:not(:disabled):hover { background: var(--hl-xs, #eef0f3); }
			.icon-button:disabled { opacity: var(--opacity-super-subtle, .35); cursor: default; }
			#position { min-width: 3.5rem; text-align: center; font-variant-numeric: tabular-nums; }
			.button { display: inline-block; padding: 8px 12px; border-radius: var(--radius-sm, 4px); background: var(--color-surprise, #7b68ee); color: var(--color-font-surprise, #fff); text-decoration: none; font-weight: 600; }
			.button[aria-disabled="true"] { opacity: var(--opacity-subtle, .6); pointer-events: none; }
			main { flex: 1; display: flex; justify-content: center; align-items: center; min-height: 0; padding: 20px; overflow: auto; }
			img { display: block; max-width: 100%; max-height: calc(100vh - 100px); object-fit: contain; background: #fff; }
			iframe { width: min(100%, 1100px); height: calc(100vh - 100px); border: 0; background: #fff; }
			#status { padding: 0 20px 16px; color: var(--color-danger, #8a351b); }
		</style>
	</head>
	<body>
		<header><h1 id="title">${first.title}</h1><div class="toolbar">${nav}${initial.download}</div></header>
		<main>${initial.image}${initial.frame}</main>
		<p id="status" role="status">${initial.status}</p>
		<script>${previewScript(descriptors)}</script>
	</body>
	</html>`;
}

module.exports.responseHooks = [
	async context => {
		const requestId = context.response.getRequestId();
		if (!requestId) {
			return;
		}

		const storageKey = `preview:${requestId}`;
		try {
			const body = Buffer.from(await context.response.getBody());
			const previews = body.length <= MAX_ENCODED_PREVIEW_BYTES
				? getPreviewData(context.response.getHeader('content-type'), body)
				: [];
			if (previews.length === 0) {
				await context.store.removeItem(storageKey);
				return;
			}

			await context.store.setItem(storageKey, JSON.stringify({
				items: previews.map(preview => ({
					format: preview.format,
					body: preview.body.toString('base64'),
				})),
			}));
		} catch (error) {
			console.warn('Could not cache response for preview', error);
		}
	},
];

module.exports.requestActions = [
	{
		label: 'Preview Label',
		icon: 'barcode',
		action: async (context, { request }) => {
			const storedResponse = await context.store.getItem(`preview:${request._id}`);
			if (!storedResponse) {
				await context.app.alert('No Preview Available', 'Send this request and make sure its response is PNG, PDF, or ZPL. Responses over 10 MB are not cached.');
				return;
			}

			try {
				const stored = JSON.parse(storedResponse);
				const storedItems = Array.isArray(stored.items) ? stored.items : [stored];
				if (storedItems.length === 0 || storedItems.some(item => !item || !['png', 'pdf', 'zpl'].includes(item.format) || typeof item.body !== 'string')) {
					throw new Error('Stored response preview data is invalid.');
				}

				if (typeof window.open !== 'function' || typeof URL.createObjectURL !== 'function') {
					throw new TypeError('This Insomnia version cannot open a preview window.');
				}

				const previewBlob = new Blob([previewPage(storedItems.map(item => ({
					format: item.format,
					body: Buffer.from(item.body, 'base64'),
				})), await readInsomniaTheme(context))], { type: 'text/html' });
				const previewUrl = URL.createObjectURL(previewBlob);
				window.open(previewUrl, '_blank', 'noopener,noreferrer');
			} catch (error) {
				await context.app.alert('Response Preview Unavailable', error instanceof Error ? error.message : String(error));
			}
		},
	},
];