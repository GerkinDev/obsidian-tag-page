import { App, MarkdownView } from 'obsidian';
import { PluginSettings, TagInfo, TagMatchDetail } from '../types';
import { getIsWildCard } from './tagSearch';

/**
 * Type definition for a function that generates content for a tag page.
 *
 * @typedef {Function} GenerateTagPageContentFn
 * @param {App} app - The Obsidian App instance.
 * @param {PluginSettings} settings - The plugin settings.
 * @param {TagInfo[]} tagsInfo - Information about tags.
 * @param {string} tagOfInterest - The tag for which the page is being generated.
 * @param {string} baseContent - The original content of the page
 * @returns {Promise<string>} - The content to be set in the tag page.
 */
export type GenerateTagPageContentFn = (
	app: App,
	settings: PluginSettings,
	tagsInfo: TagInfo,
	tagOfInterest: string,
	baseContent?: string,
) => Promise<string>;

const _parseContent = (
	baseContent: string,
) => {
	const match = baseContent.match(
		/^(?<frontmatter>---\n.*?\n---\n)?(?:(?<before>.*?)\n)?(?<tagpage>%%\ntag-page-md.*?tag-page-md end\n%%)(?:\n(?<after>.*?))?$/s,
	);
	if (!match || !match.groups) {
		return { frontmatter: '', before: '', after: '' };
	}
	return {
		frontmatter: match.groups.frontmatter ?? '',
		before: match.groups.before ?? '',
		after: match.groups.after ?? '',
	};
};

const _yieldMarkdownForTagDetails = (details: TagMatchDetail[]) => 
	details
		// Group by file
		.reduce<{fileLink: string, stringsContainingTag: string[]}[]>((acc, {fileLink, stringContainingTag}) => {
			if(!stringContainingTag.trim().startsWith('-')){
				stringContainingTag = `- ${stringContainingTag}`
			}
			const existing = acc.find(fileGroup => fileGroup.fileLink === fileLink)
			if(existing){
				existing.stringsContainingTag.push(stringContainingTag)
			} else {
				acc.push({fileLink: fileLink, stringsContainingTag: [stringContainingTag]})
			}
			return acc;
		}, [])
		// Process each tagMatch detail in this group
		.map(({ stringsContainingTag, fileLink }) => 
			`> [!quote]+ In ${fileLink}
${stringsContainingTag.map(str => `> ${str}`).join('\n')}
`
		)

/**
 * Generates the content for a tag page.
 *
 * @param {App} app - The Obsidian App instance.
 * @param {PluginSettings} settings - The plugin settings.
 * @param {TagInfo[]} tagsInfo - Information about tags.
 * @param {string} tagOfInterest - The tag for which the page is being generated.
 * @param {string} baseContent - The original content of the page
 * @returns {Promise<string>} - The content to be set in the tag page.
 */
export const generateTagPageContent: GenerateTagPageContentFn = async (
	app: App,
	settings: PluginSettings,
	tagsInfo: TagInfo,
	tagOfInterest: string,
	baseContent = '',
): Promise<string> => {
	// Generate list of links to files with this tag
	const tagPageContent: string[] = [];

	// Try to extract comments from the page to spot injection placeholder
	const { frontmatter, before, after } = _parseContent(baseContent);

	if(frontmatter){
		tagPageContent.push(frontmatter);
	}

	if (before) {
		tagPageContent.push(before);
	}
	tagPageContent.push('%%\ntag-page-md\n%%\n');

	tagPageContent.push(`## Tag Content for ${tagOfInterest.replace('*', '')}`);

	// Check if we have more than one baseTag across all tagInfos
	if (tagsInfo.size > 1) {
		// Convert the map to an array of [key, value] pairs
		const sortedTagsInfo = Array.from(tagsInfo).sort((a, b) => {
			// Sort based on the length of the keys
			return a[0].length - b[0].length;
		});

		// Iterate through each group of tags in the sorted order
		sortedTagsInfo.forEach(([baseTag, details]) => {
			// Add a subheader for the baseTag
			tagPageContent.push(`### ${baseTag}`);

			// Process each tagMatch detail in this group
			tagPageContent.push(..._yieldMarkdownForTagDetails(details))
		});
	} else {
		// If there's only one baseTag, process all tagMatches normally without subheaders
		tagsInfo.forEach((details) => {
			// Assuming there's only one baseTag, we can directly use the first (and only) key of groupedTags
			tagPageContent.push(..._yieldMarkdownForTagDetails(details))
		});
	}

	// Add Files with tag in frontmatter
	const filesWithFrontmatterTag = app.vault
		.getMarkdownFiles()
		.filter((file) => {
			const metaMatter =
				app.metadataCache.getFileCache(file)?.frontmatter;
			return metaMatter?.tags
				? metaMatter?.[settings.frontmatterQueryProperty] !== tagOfInterest && matchesTagOfInterest(metaMatter.tags, tagOfInterest)
				: false;
		})
		.map((file) => `- [[${file.basename}]]`);
	if (filesWithFrontmatterTag.length > 0) {
		const { cleanedTag } = getIsWildCard(tagOfInterest);
		tagPageContent.push(`## Files with ${cleanedTag} in frontmatter`);
		tagPageContent.push(...filesWithFrontmatterTag);
	}

	tagPageContent.push('\n%%\ntag-page-md end\n%%');
	if (after) {
		tagPageContent.push(after);
	}
	return tagPageContent.join('\n');
};

/**
 * Extracts the value of a frontmatter property from the current view's file.
 *
 * @param {App} app - The Obsidian App instance.
 * @param {MarkdownView} view - The Markdown view to extract frontmatter from.
 * @param {string} frontMatterTag - The frontmatter property to look for.
 * @returns {string | undefined} - The value of the frontmatter property, or undefined if not found.
 */
export const extractFrontMatterTagValue = (
	app: App,
	view: MarkdownView,
	frontMatterTag: string,
): string | undefined => {
	if (view.file) {
		try {
			const metaMatter = app.metadataCache.getFileCache(
				view.file,
			)?.frontmatter;

			return metaMatter?.[frontMatterTag];
		} catch (err) {
			console.log(err);
			return;
		}
	}
};

/**
 * Checks if the provided tags match the tag of interest, including wildcard patterns.
 *
 * @param {string | string[]} tags - The tag or tags found in a file's frontmatter.
 * @param {string} tagOfInterest - The tag to search for, which may include a wildcard pattern (e.g., '#daily-note/*').
 * @returns {boolean} True if the tag of interest matches (or is matched by) any of the provided tags.
 */
function matchesTagOfInterest(
	tags: string | string[],
	tagOfInterest: string,
): boolean {
	// Normalize tags to an array
	const normalizedTags = Array.isArray(tags) ? tags : [tags];

	// Prepare base tag and regex pattern for matching
	const { isWildCard, cleanedTag: tagBase } = getIsWildCard(tagOfInterest);

	// If wildcard, match any tag that starts with the base tag
	if (isWildCard) {
		return normalizedTags.some((tag) => {
			const fullTag = `#${tag}`; // Ensure it starts with '#'
			return fullTag === tagBase || fullTag.startsWith(`${tagBase}/`);
		});
	} else {
		// If not a wildcard, require an exact match
		return normalizedTags.some((tag) => `#${tag}` === tagBase);
	}
}

/**
 * Swaps the content of the current page in view with new content.
 *
 * @param {MarkdownView | null} activeLeaf - The active Markdown view leaf.
 * @param {string} newPageContent - The new content to set in the page.
 */
export const swapPageContent = (
	activeLeaf: MarkdownView | null,
	newPageContent: string,
) => {
	activeLeaf?.currentMode?.set(newPageContent, true);
};
